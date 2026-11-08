import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runExam} from '../exam-orchestrator.mjs';

test('uncertain opening is retried only after explicit confirmation and successful preflight',async()=>{
 for(const scenario of ['unconfirmed','preflight-failed','confirmed']){
  const calls=[];const call=async(path)=>{calls.push(path);if(path==='exam-state')return {phase:'open-uncertain'};if(path==='exam-preflight')return {ready:scenario!=='preflight-failed'};if(path==='exam-archive-uncertain-open')return {archived:true};if(path==='exam-history')return {records:[]};if(path==='exam-open')return {};if(path==='exam-prepare')return {matched:1,total:1,complete:true};if(path==='exam-submit')return {};if(path==='exam-verify')return {verified:true,status:'PASS'};throw Error('unexpected '+path)};
  if(scenario==='confirmed')await runExam({call,report:()=>{},allowOpenRecovery:true});else await assert.rejects(runExam({call,report:()=>{},allowOpenRecovery:scenario!=='unconfirmed'}));
  assert.equal(calls.includes('exam-archive-uncertain-open'),scenario==='confirmed');assert.equal(calls.includes('exam-open'),scenario==='confirmed');
 }
});

test('accepted submission keeps checking when scoring takes longer than the old window',async()=>{
 let checks=0,writes=0,waits=0;
 const call=async(path)=>{
  if(path==='exam-state')return {phase:'ready',resumable:false};
  if(path==='exam-preflight')return {ready:true};
  if(path==='exam-history')return {records:[]};
  if(path==='exam-open')return {phase:'active'};
  if(path==='exam-prepare')return {matched:1,total:1,complete:true};
  if(path==='exam-submit'){writes++;return {phase:'accepted'}}
  if(path==='exam-verify'){checks++;return checks<15?{status:'SCORING',verified:false}:{status:'PASS',answerScore:100,verified:true}}
  throw Error('unexpected '+path);
 };
 const result=await runExam({call,report:()=>{},sleep:async()=>{waits++}});
 assert.equal(result.result.status,'PASS');assert.equal(checks,15);assert.equal(writes,1);assert.equal(waits,14);
});

test('unconfirmed old submission is never treated as a lost session or restarted',async()=>{
 for(const scenario of ['network','scoring','not_score']){
  const calls=[];const call=async(path)=>{calls.push(path);if(path==='exam-state')return {phase:'pending',resumable:false};if(path==='exam-verify'){if(scenario==='network')throw Error('fetch failed');return {verified:false,status:scenario==='scoring'?'SCORING':'NOT_SCORE'}}throw Error('unexpected '+path)};
  await assert.rejects(runExam({call,report:()=>{},allowRecovery:true,sleep:async()=>{}}),scenario==='network'?/无法连接或核对平台/:scenario==='scoring'?/仍在评分/:/尚未返回成绩/);
  assert.equal(calls.includes('exam-archive-pending'),false);assert.equal(calls.includes('exam-open'),false);
 }
});
test('a known lost session requires confirmation and successful platform status before recovery',async()=>{
 let writes=0;const offline=async(path)=>{if(path==='exam-state')return {phase:'active',resumable:false};if(path==='exam-verify')throw Error('fetch failed');writes++;throw Error('unexpected')};
 await assert.rejects(runExam({call:offline,report:()=>{},sleep:async()=>{}}),/重新打开/);
 await assert.rejects(runExam({call:offline,report:()=>{},allowRecovery:true,sleep:async()=>{}}),/无法连接或核对平台/);assert.equal(writes,0);
});
test('an active session belonging to another login is not called lost or restarted',async()=>{
 let calls=0;await assert.rejects(runExam({call:async(path)=>{calls++;assert.equal(path,'exam-state');return {phase:'active',resumable:false,activeElsewhere:true}},report:()=>{},allowRecovery:true}),/另一登录会话/);assert.equal(calls,1);
});

test('second round waits for attributable wrong answers and requires improved coverage',async()=>{
 for(const scenario of ['missing','no-improvement','improved']){
  let opens=0,bankReads=0,verifies=0;
  const call=async path=>{
   if(path==='exam-state')return {phase:'ready'};
   if(path==='exam-preflight')return {ready:true};
   if(path==='exam-history')return {records:opens?[{current:true,handle:'h'}]:[]};
   if(path==='exam-open'){opens++;return {}}
   if(path==='exam-prepare')return {matched:opens===1?2:3,total:9,complete:false,discoveryAvailable:true};
   if(path==='exam-submit-discovery'||path==='exam-submit-partial')return {};
   if(path==='exam-verify'){verifies++;return {verified:true,status:verifies===1?'FAIL':'PASS',answerScore:verifies===1?20:80}}
   if(path==='history-result')return {result:{attendanceStatus:'FAIL',paperDisplayAnswerMode:'PASS'}};
   if(path==='history-wrong-bank'){bankReads++;return scenario==='missing'||bankReads<2?{acceptedCount:0,readable:0}:{acceptedCount:1,readable:1}}
   if(path==='exam-answer-check')return {available:true,previousMatched:2,matched:scenario==='improved'?3:2,fromBank:1};
   throw Error('unexpected '+path);
  };
  if(scenario==='improved'){const r=await runExam({call,report:()=>{},sleep:async()=>{}});assert.equal(r.result.status,'PASS');assert.equal(opens,2)}
  else{await assert.rejects(runExam({call,report:()=>{},sleep:async()=>{}}),/已停止再次考试/);assert.equal(opens,1)}
  assert.ok(bankReads>=2);
 }
});
