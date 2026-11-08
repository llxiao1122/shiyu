/** Execute a confirmed exam on the server; adapters enforce account/session identity. */
export async function runExam({call,report,allowRecovery=false,allowOpenRecovery=false,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 let stage='preflight',firstOutcome=null;
 const set=message=>report({message,stage});
 async function awaitResult(limit=12,{lostSession=false}={}){
  let lastStatus=null,lastError=null;
  for(let n=0;n<limit;n++){
   if(n)await sleep(2000);
   let result;
   try{result=await call('exam-verify');lastStatus=result.status;lastError=null}catch(e){lastError=e;set('暂时无法连接或核对平台，正在重试…');continue}
   if(result.verified)return result;
   if(lostSession&&result.status==='NOT_SCORE'){const e=Error('原答题会话已失去，平台尚未返回成绩');e.code='LOST_SESSION';throw e}
   set(result.status==='SCORING'?'平台正在评分…':result.status==='NOT_SCORE'?'平台尚未返回成绩，正在核对…':'成绩已返回，正在核对历史记录…');
  }
  if(lastError)throw Error('暂时无法连接或核对平台，请稍后重试');
  if(lastStatus==='SCORING')throw Error('平台仍在评分，请稍后查看成绩');
  if(lastStatus==='NOT_SCORE')throw Error('平台尚未返回成绩，无法确认是否已交卷，请稍后核对');
  throw Error('成绩尚未完成核验，请稍后核对');
 }
 async function submitAndVerify(endpoint){
  let submitError=null;
  try{await call(endpoint,{confirmed:true})}catch(e){
   submitError=e;
   if(['active','ready'].includes(e.phase))throw e;
   if(!e.phase){try{const current=await call('exam-state');if(['active','ready'].includes(current.phase))throw e}catch(check){if(check===e)throw e}}
   set('交卷回执未确认，正在核对原会话…');
  }
  try{return await awaitResult(60)}catch(e){if(submitError?.message?.includes('业务繁忙'))throw Error('平台提示业务繁忙，当前交卷结果尚未确认，请稍后查询');throw e}
 }
 try{
  const initial=await call('exam-state');let {phase,resumable}=initial,result;
  if(initial.activeElsewhere)throw Error('该考试仍在另一登录会话中进行，请回到原会话查看');
  const lostSession=(phase==='active'&&!resumable)||initial.lostSession===true;
  if(lostSession&&!allowRecovery)throw Error('本网站已失去原答题会话，请重新打开考试查看');
  const unresolved=['pending','accepted','submit-uncertain','submitting'].includes(phase)||(phase==='active'&&!resumable);
  if(unresolved){
   stage='verify';set('正在核对已有考试…');
   try{result=await awaitResult(12,{lostSession})}catch(error){
    if(error.code!=='LOST_SESSION')throw error;
    const current=await call('exam-state');if(current.phase!=='pending'||current.resumable)throw error;
    const pre=await call('exam-preflight');if(!pre.ready)throw Error('旧会话未确认，且剩余次数或开考条件不足');
    set('原考试未结算，正在保留旧记录…');await call('exam-archive-pending',{confirmed:true});phase='ready';
   }
  }
  if(!result){
   if(phase==='open-uncertain'&&allowOpenRecovery){
    const pre=await call('exam-preflight');if(!pre.ready)throw Error('平台尚未确认满足开考条件');
    await call('exam-archive-uncertain-open',{confirmed:true});phase='ready';
   }
   if(['opening','open-uncertain'].includes(phase))throw Error('原考试开启状态不明，请先在平台核对');
   const pre=await call('exam-preflight');if(!pre.ready)throw Error(pre.reasons.join('；'));
   set('正在读取历史答案…');const history=await call('exam-history');
   for(const row of history.records){
    const {result:r}=await call('history-result',{handle:row.handle});
    await call('history-wrong-bank',{handle:row.handle});
    if((r.attendanceStatus==='FAIL'&&r.paperDisplayAnswerMode==='FIRST')||(r.attendanceStatus==='PASS'&&['FIRST','PASS'].includes(r.paperDisplayAnswerMode)))await call('history-review',{handle:row.handle});
   }
   if(phase!=='active'){stage='open';set('正在开启考试…');await call('exam-open',{confirmed:true})}
   stage='prepare';const prepared=await call('exam-prepare',{confirmed:true});set(`第一轮已匹配 ${prepared.matched}/${prepared.total} 题，正在交卷…`);
   stage='submit';result=await submitAndVerify(prepared.complete?'exam-submit':prepared.discoveryAvailable?'exam-submit-discovery':'exam-submit-partial');stage='verify';
  }
  if(result.status==='PASS')return {result,message:'考试通过'+(result.answerScore==null?'':'，得分 '+result.answerScore)};
  firstOutcome=result;set('第一轮已完成，正在核对本次答案…');
  const history=await call('exam-history');const current=history.records.filter(row=>row.current);if(current.length!==1)throw Error('无法唯一确认第一轮考试记录');
  const handle=current[0].handle;const {result:checked}=await call('history-result',{handle});
  let bank;
  for(let attempt=0;attempt<5;attempt++){
   if(attempt){set('正在等待错题库更新…');await sleep(3000)}
   bank=await call('history-wrong-bank',{handle});
   if(bank.acceptedCount>0&&bank.readable>0)break;
  }
  let review=null;
  if((checked.attendanceStatus==='FAIL'&&checked.paperDisplayAnswerMode==='FIRST')||(checked.attendanceStatus==='PASS'&&['FIRST','PASS'].includes(checked.paperDisplayAnswerMode)))review=await call('history-review',{handle});
  if(!bank.acceptedCount||!bank.readable)throw Error('本次错题尚未完成核对，已停止再次考试');
  const checkedAnswers=await call('exam-answer-check');
  if(!checkedAnswers.available||checkedAnswers.fromBank<1||checkedAnswers.matched<=checkedAnswers.previousMatched)throw Error('错题未补充可确认答案，已停止再次考试');
  stage='open';set('正在开启第二轮考试…');await call('exam-open',{confirmed:true});
  stage='prepare';const prepared=await call('exam-prepare',{confirmed:true});
  stage='submit';set(`第二轮已匹配 ${prepared.matched}/${prepared.total} 题${prepared.complete?'':'，未匹配题留空'}，正在交卷…`);
  result=await submitAndVerify(prepared.complete?'exam-submit':'exam-submit-partial');
  return {result,message:(result.status==='PASS'?'考试通过':'考试未通过')+(result.answerScore==null?'':'，得分 '+result.answerScore)};
 }catch(e){
  const first=firstOutcome?'第一轮'+(firstOutcome.status==='PASS'?'已通过':'未通过')+(firstOutcome.answerScore==null?'':'，得分 '+firstOutcome.answerScore)+'。':'';
  throw Error(first+(e?.message||'考试未完成')+(stage==='submit'?'；请核对当前会话，勿重复交卷。':''));
 }
}
