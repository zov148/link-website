import {APP_ORIGIN,GITHUB_REPOSITORY} from './config.js';
import {releaseFile,mountReleaseDownload} from './transfer.js';

const METADATA_PATH='/api/releases/latest';
const FILE_PATH=/^\/api\/releases\/files\/LINK-(?:Setup-)?\d+\.\d+\.\d+-Windows-x64\.exe$/;

export function releaseURL(path){
  if(typeof path!=='string'||path!==METADATA_PATH&&!FILE_PATH.test(path))throw Error('Недопустимый адрес сборки.');
  return APP_ORIGIN+path;
}

// Credentials and redirects are never forwarded from the public website.
export function createReleaseFetcher(fetcher=globalThis.fetch){
  return (path,options={})=>{
    if(!['GET','HEAD'].includes(options.method||'GET'))throw Error('Сборки доступны только для чтения.');
    const headers=new Headers(options.headers);
    for(const name of headers.keys())if(!['range','if-range'].includes(name))throw Error('Недопустимый заголовок скачивания.');
    return fetcher(releaseURL(path),{...options,headers,method:options.method||'GET',mode:'cors',credentials:'omit',redirect:'error'});
  };
}

export function validateRelease(value){
  if(!value||typeof value.version!=='string'||value.version.length>32||typeof value.signed!=='boolean'||!Array.isArray(value.files)||value.files.length!==2)throw Error('Не удалось проверить данные сборки.');
  const kinds=new Set(),files=value.files.map(file=>{
    if(!file||typeof file.available!=='boolean'||kinds.has(file.kind))throw Error('Не удалось проверить данные сборки.');
    kinds.add(file.kind);const checked=releaseFile({...file,available:true},value.version);
    return Object.freeze({...checked,available:file.available});
  });
  return Object.freeze({version:value.version,signed:value.signed,files:Object.freeze(files)});
}

export async function loadRelease(fetcher=createReleaseFetcher(),{timeoutMs=15000}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Сервер скачивания не ответил вовремя.','TimeoutError')),timeoutMs);let reader;
  try{
    const response=await fetcher(METADATA_PATH,{cache:'no-store',signal:controller.signal});
    if(!response.ok)throw Error('Сервер скачивания временно недоступен.');
    reader=response.body?.getReader();if(!reader)throw Error('Сервер не вернул данные сборки.');
    const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768)throw Error('Ответ сервера слишком большой.');chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return validateRelease(JSON.parse(new TextDecoder().decode(bytes)));
  }finally{clearTimeout(timer);try{await reader?.cancel();}catch{}try{reader?.releaseLock();}catch{}}
}

export function repositoryURL(value){
  if(typeof value!=='string'||!/^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+\/?$/.test(value))return null;
  return value.replace(/\/$/,'');
}

const megabytes=n=>(n/1048576).toFixed(0)+' МБ';
const initialized=new WeakSet();
export async function initDownloads({root=document,fetcher=createReleaseFetcher()}={}){
  if(initialized.has(root))return;initialized.add(root);
  const one=selector=>root.querySelector(selector),all=selector=>root.querySelectorAll(selector);
  for(const anchor of all('[data-open-app]'))anchor.href=APP_ORIGIN+'/';
  const github=repositoryURL(GITHUB_REPOSITORY);
  for(const anchor of all('[data-github]')){anchor.hidden=!github;if(github){anchor.href=github;anchor.rel='noopener noreferrer';}}
  const installerLink=one('#installer'),portableLink=one('#portable'),button=one('#managed-download'),error=one('#build-error');
  const integrityPanel=one('#integrity');if(integrityPanel)integrityPanel.hidden=true;
  // Until fresh metadata is verified, the actual app download center is a safe fallback.
  for(const anchor of all('[data-download-main]'))anchor.href=APP_ORIGIN+'/download';
  if(!installerLink)return;
  const disable=element=>{if(!element)return;element.removeAttribute('href');element.setAttribute('aria-disabled','true');element.classList.add('disabled');};
  disable(installerLink);disable(portableLink);if(button)button.hidden=true;
  try{
    const release=await loadRelease(fetcher),installer=release.files.find(file=>file.kind==='installer'),portable=release.files.find(file=>file.kind==='portable');
    for(const span of all('[data-version]'))span.textContent=release.version;
    const notice=one('#unsigned-notice');if(notice)notice.hidden=release.signed;
    if(installer?.available){
      installerLink.href=releaseURL(installer.url);installerLink.removeAttribute('aria-disabled');installerLink.classList.remove('disabled');installerLink.textContent='Обычное скачивание';
      const info=one('#build-info');if(info)info.textContent=`Версия ${release.version} · ${megabytes(installer.size)} · Windows 10/11 x64${release.signed?'':' · тестовая сборка'}`;
      mountReleaseDownload(installer,{fetcher});
      const managed=button&&!button.hidden;
      if(managed)button.textContent='Скачать для Windows';else installerLink.textContent='Скачать для Windows';
      for(const anchor of all('[data-download-main]')){
        anchor.href=releaseURL(installer.url);
        if(managed)anchor.addEventListener('click',event=>{event.preventDefault();if(!button.disabled)button.click();one('#release-transfer')?.scrollIntoView({block:'nearest',behavior:'instant'});});
      }
    }else{installerLink.textContent='Сборка пока недоступна';if(error)error.textContent='Скачивание появится после публикации сборки. Пока можно открыть LINK в браузере.';}
    if(portable?.available&&portableLink){portableLink.href=releaseURL(portable.url);portableLink.hidden=false;portableLink.removeAttribute('aria-disabled');portableLink.classList.remove('disabled');portableLink.textContent=`Переносимая версия · ${megabytes(portable.size)}`;}
    const integrity=one('#integrity'),hashes=one('#hashes');
    if(integrity&&hashes){hashes.replaceChildren();for(const file of release.files.filter(file=>file.available)){const row=root.createElement('pre');row.textContent=file.name+'\nSHA-256: '+file.sha256;hashes.append(row);}integrity.hidden=!hashes.childElementCount;}
  }catch{installerLink.textContent='Скачивание недоступно';if(error)error.textContent='Не удалось проверить текущую сборку. Обнови страницу или открой LINK в браузере.';}
}

if(typeof document!=='undefined')initDownloads();
