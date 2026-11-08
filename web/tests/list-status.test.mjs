import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port}
async function waitFor(url){for(let i=0;i<100;i++){try{await fetch(url);return}catch{}await new Promise(resolve=>setTimeout(resolve,50))}throw Error('server did not start')}

test('completed tab includes only verified passes and failed exams stay pending',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'learn-list-status-'));
 const histories={
  pass:{detailId:'detail-pass',enrollmentId:'enrollment-pass',sessionId:'session-pass',status:'PASS',answerScore:90},
  fail:{detailId:'detail-fail',enrollmentId:'enrollment-fail',sessionId:'session-fail',status:'FAIL',answerScore:70},
 };
 const exams={
  active:{id:'active',resourceId:'resource-active',title:'进行中的考试',status:'PROGRESS',finished:false},
  pass:{id:'pass',resourceId:'resource-pass',activityEnrollmentId:'enrollment-pass',title:'已通过考试',status:'COMPLETED',finished:true},
  fail:{id:'fail',resourceId:'resource-fail',activityEnrollmentId:'enrollment-fail',title:'未通过考试',status:'COMPLETED',finished:true},
 };
 const upstream=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');let result={code:200,data:{}};
  if(req.url==='/gateway/organization/api/open/login/encrypt/loginByAccount')result.data={token:'mock-token',user:{id:'user'}};
  else if(req.url==='/gateway/exam/api/learn/get-training-exam'){
   const finished=body.params.finished;
   result.data={content:{records:finished===1?[exams.pass,exams.fail]:[exams.active],pages:1,current:1}};
  }else if(req.url==='/gateway/exam/api/learn/paper/detail'){
   const key=body.id;const exam=Object.values(exams).find(item=>item.id===key);const history=histories[key];
   result.data={id:history?.detailId||'detail-active',activityId:key,activityEnrollmentId:history?.enrollmentId||'enrollment-active',attempt:0,myAttempt:0};
  }else if(req.url==='/gateway/activity/api/resource/paper-historical-achievements'){
   const item=Object.values(histories).find(value=>value.detailId===body.id);
   result.data={id:body.id,activityId:item?body.id.replace('detail-',''):'active',activityEnrollmentId:item?.enrollmentId||'enrollment-active',paperRecordList:item?[{resourceId:body.id,activityId:body.id.replace('detail-',''),activityEnrollmentId:item.enrollmentId,learningSessionId:item.sessionId,attendanceStatus:item.status,answerScore:item.answerScore}]:[]};
  }else if(req.url==='/gateway/activity/api/resource/paper-record'){
   const item=Object.values(histories).find(value=>value.sessionId===body.learningSessionId);
   result.data={id:body.id,resourceId:body.id,activityId:body.id.replace('detail-',''),activityEnrollmentId:body.activityEnrollmentId,learningSessionId:body.learningSessionId,attendanceStatus:item.status,answerScore:item.answerScore,score:100,passScore:80};
  }else{res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 });
 const upstreamPort=await listen(upstream),reserve=createServer(),port=await listen(reserve);await new Promise(resolve=>reserve.close(resolve));
 const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),LEARN_UPSTREAM:`http://127.0.0.1:${upstreamPort}`,LEARN_JOURNAL:join(dir,'journal.json'),NODE_USE_ENV_PROXY:'0'},stdio:'ignore'});
 let cookie='';
 const post=async(path,data={})=>{const response=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,body:await response.json()}};
 try{
  await waitFor(`http://127.0.0.1:${port}/`);
  assert.equal((await post('login',{orgCode:'ZGXY',username:'user',password:'pass'})).status,200);
  const passed=await post('exams',{finished:1,page:1});
  assert.deepEqual(passed.body.records.map(item=>[item.id,item.status]),[['pass','PASS']]);
  const pending=await post('exams',{finished:0,page:1});
  assert.deepEqual(pending.body.records.map(item=>[item.id,item.status]).sort(),[['active','PROGRESS'],['fail','FAIL']]);
 }finally{
  child.kill();await new Promise(resolve=>child.once('exit',resolve));await new Promise(resolve=>upstream.close(resolve));rmSync(dir,{recursive:true,force:true});
 }
});
