import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function listen(s){await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port}
async function wait(url){for(let i=0;i<150;i++){try{if((await fetch(url)).ok)return}catch{}await delay(25)}throw Error('startup timeout')}
test('client timeout while server continues processing never causes a second submission',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'learn-delay-'));let submissions=0,applied=false;
 const upstream=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');let data={code:200,data:{}};
 switch(req.url){
 case '/gateway/organization/api/open/login/encrypt/loginByAccount':data.data={token:'synthetic',user:{id:'u'}};break;
 case '/gateway/exam/api/learn/get-training-exam':data.data={content:{records:[{id:'row',resourceId:'resource'}],current:1,pages:1}};break;
 case '/gateway/exam/api/learn/paper/detail':data.data={id:'detail',activityId:'activity',activityEnrollmentId:'enrollment',attempt:2,myAttempt:2};break;
 case '/gateway/organization/api/recognition/getFaceCheckConfig':data.data={faceCheckConfig:{faceInd:false}};break;
 case '/gateway/activity/api/activity-resource/open-evaluation-resource':data.data={learningToken:'synthetic',learningSessionId:'session',papers:[{id:'q',type:'S',questionOptionList:[{id:'a',correctInd:true}]}]};break;
 case '/gateway/activity/api/activity-resource/submits-evaluation-resource':submissions++;assert.equal(body.data.learningSessionId,'session');await delay(800);applied=true;break;
 case '/gateway/activity/api/resource/paper-record':data.data={id:'detail',learningSessionId:'session',attendanceStatus:applied?'PASS':'SCORING',answerScore:applied?100:null};break;
 case '/gateway/activity/api/resource/paper-historical-achievements':data.data={id:'detail',paperRecordList:applied?[{learningSessionId:'session',attendanceStatus:'PASS',answerScore:100}]:[]};break;
 default:res.writeHead(404);res.end();return;
 }res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));});
 const up=await listen(upstream),reserve=createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),LEARN_UPSTREAM:`http://127.0.0.1:${up}`,LEARN_TEST_TIMEOUT_MS:'200',LEARN_JOURNAL:join(dir,'journal.json'),NODE_USE_ENV_PROXY:'0'},stdio:'ignore'});let cookie='';
 const post=async(path,data)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,body:await r.json()}};const request={id:'row'};
 try{await wait(`http://127.0.0.1:${port}/`);await post('login',{orgCode:'x',username:'x',password:'x'});await post('exams',{});await post('exam-detail',request);await post('exam-open',{...request,confirmed:true});await post('exam-prepare',{...request,confirmed:true});const timed=await post('exam-submit',{...request,confirmed:true});assert.equal(timed.status,409);assert.equal(timed.body.phase,'submit-uncertain');assert.ok(timed.body.elapsedMs>=150);assert.equal(submissions,1);const pending=await post('exam-verify',request);assert.equal(pending.body.status,'SCORING');assert.equal(pending.body.verified,false);assert.equal((await post('exam-submit',{...request,confirmed:true})).status,409);await delay(850);const final=await post('exam-verify',request);assert.equal(final.body.status,'PASS');assert.equal(final.body.verified,true);assert.equal(submissions,1)}finally{child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true})}
});
