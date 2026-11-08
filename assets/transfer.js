import {sha256} from './vendor/hash/sha256.js';

export function releaseFile(file,version){
  if(!/^\d+\.\d+\.\d+$/.test(version||'')||!file?.available||!['installer','portable'].includes(file.kind))throw Error('Эта сборка недоступна.');
  const expected=file.kind==='installer'?`LINK-Setup-${version}-Windows-x64.exe`:`LINK-${version}-Windows-x64.exe`;
  if(file.name!==expected||file.url!=='/api/releases/files/'+expected||!Number.isSafeInteger(file.size)||file.size<1||file.size>256*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256||''))throw Error('Некорректные данные сборки.');
  return Object.freeze({...file});
}

// Disk-backed writes keep the installer out of JS heap. The browser commits
// the chosen file only after a successful size/hash check and close().
export class ReleaseTransfer {
  constructor(file,{fetcher=fetch,onChange=()=>{},clock=()=>performance.now()}={}){this.file=file;this.fetcher=fetcher;this.onChange=onChange;this.clock=clock;this.received=0;this.phase='idle';this.hash=sha256.create();this.speed=0;}
  state(){return {phase:this.phase,received:this.received,total:this.file.size,percent:Math.floor(100*this.received/this.file.size),speed:this.speed,remaining:this.speed>0?(this.file.size-this.received)/this.speed:null,error:this.error||''};}
  emit(){this.onChange(this.state());}
  async start(handle){this.handle=handle;this.writer=await handle.createWritable();this.received=0;this.hash=sha256.create();return this.resume();}
  resume(){if(this.busy||this.phase==='complete')return this.task;if(!this.writer)return this.start(this.handle);this.busy=true;this.paused=false;this.cancelled=false;this.error='';this.speed=0;this.controller=new AbortController();this.phase='connecting';this.emit();this.task=this.run().finally(()=>{this.busy=false;this.controller=null;});return this.task;}
  async run(){
    const start=this.received,began=this.clock();let last=began,requestAbort;
    try{
      while(this.received<this.file.size){
        const offset=this.received,end=Math.min(this.file.size-1,offset+4*1024*1024-1);requestAbort=new AbortController();
        const response=await this.fetcher(this.file.url,{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.any([this.controller.signal,requestAbort.signal,AbortSignal.timeout(45000)]),headers:{Range:'bytes='+offset+'-'+end,'If-Range':'"'+this.file.sha256+'"'}});this.response=response;
        if(![200,206].includes(response.status)||offset&&response.status===200)throw Error(offset?'Сервер не смог продолжить загрузку. Отмени её и начни заново.':'Сервер временно не отдаёт файл. Попробуй ещё раз.');
        const partial=response.status===206,expected=partial?end-offset+1:this.file.size,range=response.headers.get('content-range'),length=response.headers.get('content-length');
        if(length!==null&&Number(length)!==expected||partial&&range!=='bytes '+offset+'-'+end+'/'+this.file.size)throw Error('Сервер вернул неверный диапазон файла.');
        if(response.headers.get('etag')&&response.headers.get('etag')!=='"'+this.file.sha256+'"')throw Error('Сборка на сервере изменилась. Обнови страницу.');
        const reader=response.body?.getReader();if(!reader)throw Error('Потоковая загрузка не поддерживается. Используй обычную ссылку скачивания.');this.reader=reader;this.phase='downloading';this.emit();let receivedHere=0;
        while(receivedHere<expected){const {done,value}=await reader.read();if(done)break;if(this.paused||this.cancelled)throw Error('Загрузка прервана.');if(receivedHere+value.byteLength>expected||this.received+value.byteLength>this.file.size)throw Error('Размер файла не совпадает.');
          await this.writer.write({type:'write',position:this.received,data:value});this.hash.update(value);this.received+=value.byteLength;receivedHere+=value.byteLength;
          const now=this.clock();this.speed=(this.received-start)/Math.max(.001,(now-began)/1000);if(now-last>=200){last=now;this.emit();}
        }
        requestAbort.abort();try{await reader.cancel();reader.releaseLock();}catch{}this.reader=null;this.response=null;
        if(this.paused||this.cancelled)throw Error('Загрузка прервана.');if(receivedHere!==expected)throw Error('Соединение прервалось до конца части. Нажми «Продолжить».');
      }
      if(this.paused||this.cancelled)throw Error('Загрузка прервана.');if(this.received!==this.file.size)throw Error('Соединение прервалось до конца файла. Нажми «Продолжить».');
      this.phase='verifying';this.emit();const digest=Array.from(this.hash.digest(),b=>b.toString(16).padStart(2,'0')).join('');
      if(digest!==this.file.sha256){await this.writer.abort();this.writer=null;throw Error('Проверка SHA-256 не пройдена. Файл не сохранён; повтори загрузку.');}
      await this.writer.truncate(this.file.size);await this.writer.close();this.writer=null;this.phase='complete';this.emit();
    }catch(error){if(this.phase==='verifying'){try{await this.writer?.abort();}catch{}this.writer=null;}if(this.cancelled){this.phase='cancelled';}else if(this.paused){this.phase='paused';}else{this.phase='error';this.error=error.name==='QuotaExceededError'?'Недостаточно места или браузер запретил запись. Освободи место и повтори.':error.message;}this.emit();}
    finally{requestAbort?.abort();try{if(this.reader)await this.reader.cancel();else await this.response?.body?.cancel();}catch{}this.reader=null;this.response=null;}
  }
  pause(){if(!['connecting','downloading'].includes(this.phase))return;this.paused=true;this.controller?.abort();this.reader?.cancel().catch(()=>{});}
  async cancel(){this.cancelled=true;this.controller?.abort();try{await this.task;}catch{}try{await this.writer?.abort();}catch{}this.writer=null;this.phase='cancelled';this.emit();}
}

export function mountReleaseDownload(file,{fetcher=fetch}={}){
  const box=document.querySelector('#release-transfer'),button=document.querySelector('#managed-download');if(!box||!button||!window.showSaveFilePicker||window.orbitDesktop)return;
  button.hidden=false;let transfer=null;
  const labels={connecting:'Подключение к серверу',downloading:'Скачивание LINK',verifying:'Проверка SHA-256',paused:'Загрузка приостановлена',error:'Не удалось завершить загрузку',complete:'Файл проверен и сохранён',cancelled:'Загрузка отменена'};
  const mb=n=>(n/1048576).toFixed(1)+' МБ',draw=state=>{
    box.hidden=false;box.querySelector('[data-transfer-stage]').textContent=labels[state.phase]||'Подготовка';box.querySelector('progress').value=state.percent;box.querySelector('[data-transfer-percent]').textContent=state.percent+'%';
    box.querySelector('[data-transfer-bytes]').textContent=mb(state.received)+' / '+mb(state.total);box.querySelector('[data-transfer-speed]').textContent=state.phase==='downloading'?mb(state.speed)+'/с':'—';box.querySelector('[data-transfer-eta]').textContent=state.remaining!==null&&state.phase==='downloading'?'≈ '+Math.ceil(state.remaining)+' с':'—';
    box.querySelector('[data-transfer-error]').textContent=state.error|| (state.phase==='complete'?'Открой сохранённый установщик. Запросы безопасности Windows остаются под твоим контролем.':'');
    const pause=box.querySelector('[data-transfer-pause]');pause.hidden=!['connecting','downloading','paused','error'].includes(state.phase);pause.textContent=['paused','error'].includes(state.phase)?'Продолжить':'Пауза';
    box.querySelector('[data-transfer-cancel]').hidden=['complete','cancelled'].includes(state.phase);button.disabled=!['complete','cancelled'].includes(state.phase);
  };
  button.onclick=async()=>{try{const handle=await window.showSaveFilePicker({suggestedName:file.name,types:[{description:'Установщик LINK для Windows',accept:{'application/octet-stream':['.exe']}}]});transfer=new ReleaseTransfer(file,{fetcher,onChange:draw});await transfer.start(handle);}catch(e){if(e.name!=='AbortError'){box.hidden=false;box.querySelector('[data-transfer-error]').textContent=e.message;}button.disabled=false;}};
  box.querySelector('[data-transfer-pause]').onclick=()=>{if(['paused','error'].includes(transfer?.phase))transfer.resume();else transfer?.pause();};box.querySelector('[data-transfer-cancel]').onclick=()=>transfer?.cancel();window.addEventListener('pagehide',()=>transfer?.cancel(),{once:true});
}
