#!/bin/bash
ID="266184eb-14d9-4500-ae92-5b620edc17ff"
GH="https://github.com/user-attachments/assets/$ID"
# 直接用 node 从容器 fetch 各候选
docker exec apertureprism-ai-review-analysis-worker-1 node -e "
const GH='$GH';
const cands=[
 ['direct-github', GH],
 ['gh-proxy.com', 'https://gh-proxy.com/'+GH],
 ['ghproxy.net', 'https://ghproxy.net/'+GH],
 ['ghfast.top', 'https://ghfast.top/'+GH],
 ['gh.ddlc.top', 'https://gh.ddlc.top/'+GH],
 ['ghps.cc', 'https://ghps.cc/'+GH],
 ['user-images direct', 'https://user-images.githubusercontent.com/$ID'],
 ['obj.githubusercontent', 'https://objects.githubusercontent.com/$ID'],
];
(async()=>{
for(const [name,u] of cands){
 try{
  const c=new AbortController();const t=setTimeout(()=>c.abort(),12000);
  const r=await fetch(u,{signal:c.signal});clearTimeout(t);
  if(r.ok){const b=new Uint8Array(await r.arrayBuffer());console.log(name,'OK status',r.status,'bytes',b.byteLength,'head',Array.from(b.slice(0,4)));}
  else{const te=await r.text();console.log(name,'HTTP',r.status,'len',te.length,'body',te.slice(0,40).replace(/\s+/g,' '));}
 }catch(e){console.log(name,'ERR',e.name,e.message);}
}
})();
" 2>&1