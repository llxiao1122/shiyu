import {resolvePaper,diagnosePaper} from './answer-engine.mjs';
const present=x=>typeof x==='string'&&x.length>0;
const writesInFlight=new Set();
const liveKeys=new Set();
export function isSupersededLogin(response) {
 return Number(response?.code)===-1&&response?.message==='账号在其他设备登录'&&response?.data==null;
}
export function checkAttempt(detail) {
 if(!Number.isInteger(detail?.attempt)||detail.attempt<0||!Number.isInteger(detail?.myAttempt)) throw Error('考试次数信息不完整');
 if(detail.attempt>0&&detail.myAttempt<=0) throw Error('剩余考试次数不足');
}
export function checkFace(config) {
 if(typeof config?.faceInd!=='boolean') throw Error('无法确认人脸验证策略');
 if(config.faceInd) throw Error('考试需要官方人脸验证，无法继续');
}
export function checkSchedule(detail) {
 const {examStartTime:start,examEndTime:end,nowTime:now,unifiedExamInd:unified}=detail;
 if(unified===true && !start && !end) throw Error('统一考试时间未返回');
 if(!start&&!end) return;
 const parse=s=>typeof s==='string'&&s.trim()?Date.parse(s.replace(/-/g,'/')):NaN;
 const current=parse(now),begin=start?parse(start):null,finish=end?parse(end):null;
 if(!Number.isFinite(current)||(start&&!Number.isFinite(begin))||(end&&!Number.isFinite(finish))) throw Error('考试时间无法确认');
 if((begin!==null&&current<begin)||(finish!==null&&current>finish)) throw Error('当前不在考试时间内');
}
export function checkResult(result,context) {
 if(!result||typeof result!=='object') throw Error('结果尚未返回');
 for(const [field,value] of [['id',context.id],['resourceId',context.id],['activityEnrollmentId',context.enrollmentId],['learningSessionId',context.sessionId]]) {
  if(result[field]!=null&&String(result[field])!==value) throw Error('结果身份不一致');
 }
 if(!['PASS','FAIL','NOT_SCORE','SCORING'].includes(result.attendanceStatus)) throw Error('结果状态无法确认');
 const score=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):null;
 return {status:result.attendanceStatus,answerScore:score(result.answerScore),score:score(result.score),passScore:score(result.passScore)};
}
export function checkHistory(response,context,result) {
 if(response?.code!==200) return false;
 const container=response.data,rows=Array.isArray(container)?container:container?.paperRecordList;
 if(!Array.isArray(rows)) return false;
 for(const [field,expected] of [['id',context.id],['activityEnrollmentId',context.enrollmentId],['activityId',context.activityId]]) if(!Array.isArray(container)&&container?.[field]!=null&&String(container[field])!==expected) throw Error('历史记录身份不一致');
 const matched=rows.filter(row=>String(row?.learningSessionId??'')===context.sessionId);
 if(matched.length===0) return false;
 if(matched.length!==1) throw Error('历史会话记录不唯一');
 const row=matched[0];
 for(const [field,expected] of [['resourceId',context.id],['activityEnrollmentId',context.enrollmentId],['activityId',context.activityId]]) if(row[field]!=null&&String(row[field])!==expected) throw Error('历史记录身份不一致');
 if(row.attendanceStatus!=null&&row.attendanceStatus!==result.status) throw Error('历史记录的考试状态与结果不一致');
 if(row.answerScore!=null&&result.answerScore!=null&&Number(row.answerScore)!==Number(result.answerScore)) throw Error('历史记录得分与结果不一致');
 return true;
}
/** Journal stores only identity/state; retry an explicit busy rejection only after checking the original session. */
export class ExamFlow {
 constructor({journal,api,clock=()=>performance.now(),audit=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {this.journal=journal;this.api=api;this.clock=clock;this.audit=audit;this.sleep=sleep;this.live=new Map();this.previousPaper=new Map();this.verifying=new Set();}
 discardLive(){for(const key of this.live.keys())liveKeys.delete(key);this.live.clear();}
 key(userId,id){return `${userId}:${id}`;}
 archivePending(key){
  if(writesInFlight.has(key)||liveKeys.has(key))throw Error('原考试仍在处理中');
  this.journal.archivePending(key);
 }
 archiveUncertainOpen(key){
  if(writesInFlight.has(key)||liveKeys.has(key))throw Error('原考试仍在处理中');
  this.journal.archiveUncertainOpen(key);
 }
 status(key){
  const state=this.journal.get(key),phase=state?.phase||'ready',deadline=this.live.get(key)?.deadline;
  return {phase,resumable:phase==='active'&&this.live.has(key),...(phase==='active'&&!this.live.has(key)&&liveKeys.has(key)?{activeElsewhere:true}:{}),...(phase==='pending'&&state?.lostSession?{lostSession:true}:{}),remainingSeconds:phase==='active'&&Number.isFinite(deadline)?Math.max(0,Math.floor((deadline-this.clock())/1000)):null,outcome:phase==='verified'?(state.outcome||null):null};
 }
 async open({userId,detail,face,confirmed}) {
  if(confirmed!==true) throw Error('需要确认开考');
  if(!present(userId)||!present(detail?.id)||!present(detail?.activityId)||!present(detail?.activityEnrollmentId)) throw Error('考项身份不完整');
  checkAttempt(detail);checkFace(face);checkSchedule(detail);
  const key=this.key(userId,detail.id);const previous=this.journal.get(key);if(previous && previous.phase!=='verified') throw Error('当前考项已有未结束操作');
  const context={userId,id:detail.id,activityId:detail.activityId,enrollmentId:detail.activityEnrollmentId};
  if(this.journal.startAttempt)this.journal.startAttempt(key,{...context,phase:'opening'});
  else this.journal.put(key,{...context,phase:'opening'});
  const requestStarted=this.clock();
  let received=false;
  try {
   const r=await this.api.open({mode:'LEARN',id:context.id,activityId:context.activityId,activityEnrollmentId:context.enrollmentId});
   received=true;
   this.audit('open-response',context,{code:typeof r?.code==='number'||typeof r?.code==='string'?r.code:null,
    hasLearningToken:present(r?.data?.learningToken),hasSessionId:present(r?.data?.learningSessionId),
    paperCount:Array.isArray(r?.data?.papers)?r.data.papers.length:null,loginReplaced:isSupersededLogin(r)});
   if(isSupersededLogin(r)) {
    this.journal.put(key,{...context,phase:'open-uncertain'});
    if(typeof this.journal.archiveUncertainOpen==='function')this.journal.archiveUncertainOpen(key);
    const error=Error('登录状态已失效，请重新登录后重试');error.openRejected=true;throw error;
   }
   if(r?.code!==200||!present(r.data?.learningToken)||!present(r.data?.learningSessionId)||!Array.isArray(r.data?.papers)||!r.data.papers.length) throw Error('开启回执未确认');
   const sessionId=r.data.learningSessionId;
   if(this.journal.archivesFor?.(context).some(item=>item.state.sessionId===sessionId))throw Error('平台返回了先前未决会话，已停止自动交卷');
   const paper=r.data.papers.map((q,index)=>({...q,index}));
   this.journal.put(key,{...context,sessionId,phase:'active'});
   let seconds=null;
   const validTime=x=>(typeof x==='number'&&Number.isFinite(x))||(typeof x==='string'&&/^\d+(?:\.\d+)?$/.test(x));
   if(r.data.unifiedExamInd===true&&validTime(r.data.surplusSecond)&&Number(r.data.surplusSecond)>=0) seconds=Number(r.data.surplusSecond);
   if(r.data.unifiedExamInd===false&&validTime(r.data.resource?.time)&&Number(r.data.resource.time)>0) seconds=Number(r.data.resource.time)*60;
   const deadline=Number.isFinite(seconds)&&seconds<=31*24*60*60?requestStarted+seconds*1000:null;
   this.live.set(key,{token:r.data.learningToken,paper,attempt:detail.attempt,remaining:detail.myAttempt,deadline});
   liveKeys.add(key);
   return {key,total:paper.length,...this.status(key)};
  } catch(e) {
   if(!received)this.audit('open-error',context,{kind:e?.name==='TimeoutError'||e?.name==='AbortError'?'timeout':'request-failed'});
   if(!e.openRejected)this.journal.put(key,{...context,phase:'open-uncertain'});throw e;
  }
 }
 prepare(key,{review=[],wrongBank=[]}={}) {
  const state=this.journal.get(key),live=this.live.get(key);
  if(state?.phase!=='active'||!live) throw Error('当前考试会话不可用');
  const matches=resolvePaper(live.paper,review,wrongBank);live.records=matches.complete?matches.records:null;live.partialRecords=matches.complete?null:matches.partialRecords;
  live.matched=matches.matched;
  const available=matches.complete?matches.records:matches.partialRecords;
  const preview=live.paper.map((q,index)=>{
   const record=available?.[index];const options=Array.isArray(q.questionOptionList)?q.questionOptionList:[];
   const matched=!!record&&(Array.isArray(record.optionRecords)||typeof record.answer==='string');
   const answers=!matched?[]:record.optionRecords?record.optionRecords.map(o=>o.answer??options.find(x=>x.id===o.optionId)?.content??'选项内容未返回'):[record.answer];
   return {index:index+1,type:q.type,content:q.content||q.questionContent||q.title||'',matched,answers,reason:matched?null:matches.issues?.[index]||'题目身份或类型无法核对'};
  });
  const discoveryAvailable=!matches.complete&&Array.isArray(matches.partialRecords)&&(live.attempt===0||live.remaining>=2);
  this.audit('prepare',state,{total:matches.total,matched:matches.matched,direct:matches.direct,fromBank:matches.fromBank,fromReview:matches.fromReview});
  if(!matches.complete)this.audit('unmatched',state,{questions:live.paper.filter((q,i)=>matches.issues[i]).map((q)=>({type:q.type,reason:matches.issues[q.index],reviewSameId:review.filter(x=>x.id===q.id&&(x.type||x.questionType)===q.type).length,bankSameId:wrongBank.filter(x=>x.id===q.id&&(x.type||x.questionType)===q.type).length,hasStem:!!(q.content||q.questionContent),optionCount:q.questionOptionList?.length??0}))});
  return {complete:matches.complete,total:matches.total,matched:matches.matched,direct:matches.direct,fromBank:matches.fromBank,fromReview:matches.fromReview,discoveryAvailable,preview};
 }
 diagnostics(key,sources){const state=this.journal.get(key),live=this.live.get(key);if(state?.phase!=='active'||!live)throw Error('当前考试会话不可用');return diagnosePaper(live.paper,sources);}
 comparePrevious(key,{review=[],wrongBank=[]}={}){const previous=this.previousPaper.get(key);if(!previous)return {available:false};const result=resolvePaper(previous.paper,review,wrongBank);return {available:true,previousMatched:previous.matched,matched:result.matched,total:result.total,fromBank:result.fromBank};}
 async submit(key,{confirmed,discovery=false,finalPartial=false}) {
  if(confirmed!==true) throw Error('需要确认交卷');
  const state=this.journal.get(key),live=this.live.get(key);
  if(state?.phase!=='active'||!live) throw Error('答案不完整或会话不可用');
  const records=discovery===true?live.partialRecords:live.records;
  if(!records) throw Error('答案不完整或会话不可用');
  if(discovery===true&&!finalPartial&&live.attempt>0&&live.remaining<2) throw Error('首次探测至少需要剩余两次考试机会');
  this.journal.put(key,{...state,phase:'submitting'});
  this.previousPaper.set(key,{paper:live.paper,matched:live.matched??0});
  writesInFlight.add(key);
  const started=this.clock();
  try {
   const payload={mode:'LEARN',id:state.id,activityId:state.activityId,activityEnrollmentId:state.enrollmentId,learningToken:live.token,data:{activityEnrollmentId:state.enrollmentId,learningSessionId:state.sessionId,resourceId:state.id,autoInd:false,questionRecords:records}};
   let r=await this.api.submit(payload);
   for(let retry=0;retry<12&&r?.code===500&&typeof r.message==='string'&&r.message.startsWith('业务繁忙');retry++){
    const record=await this.api.result({id:state.id,activityEnrollmentId:state.enrollmentId,learningSessionId:state.sessionId});
    if(record?.code!==200)break;
    const result=checkResult(record.data,state);
    if(result.status!=='NOT_SCORE')break;
    const history=await this.api.history({id:state.id});
    const rows=Array.isArray(history?.data)?history.data:history?.data?.paperRecordList;
    if(history?.code!==200||!Array.isArray(rows)||checkHistory(history,state,result))break;
    await this.sleep(1500);
    this.audit('submit-retry',state,{attempt:retry+1,reason:'busy'});
    r=await this.api.submit(payload);
   }
   if(r?.code!==200) {this.audit('submit-response',state,{code:typeof r?.code==='number'||typeof r?.code==='string'?r.code:null,message:typeof r?.message==='string'?r.message.slice(0,200):null});throw Error(typeof r?.message==='string'&&r.message.startsWith('业务繁忙')?'平台提示业务繁忙，交卷结果尚未确认':'交卷回执未确认');}
   this.journal.put(key,{...state,phase:'accepted'});
   this.audit('submit',state,{result:'accepted',elapsedMs:Math.max(0,Math.round(this.clock()-started)),discovery});
   return {phase:'accepted',elapsedMs:Math.max(0,Math.round(this.clock()-started))};
  } catch(e) {this.journal.put(key,{...state,phase:'submit-uncertain'});this.audit('submit',state,{result:'uncertain',elapsedMs:Math.max(0,Math.round(this.clock()-started)),discovery});if(e&&typeof e==='object')e.writeElapsedMs=Math.max(0,Math.round(this.clock()-started));throw e;}
  finally {writesInFlight.delete(key);this.live.delete(key);liveKeys.delete(key);}
 }
 async verify(key) {
  const state=this.journal.get(key);
  if(state?.phase==='verified'&&state.outcome) return {...state.outcome,verified:true};
  const orphaned=state?.phase==='active'&&!liveKeys.has(key);
  if(!state||(!orphaned&&!['submitting','accepted','submit-uncertain','pending'].includes(state.phase))||!present(state.sessionId)) throw Error('没有可核对的提交会话');
  if(writesInFlight.has(key)) throw Error('交卷请求仍在处理中');
  if(this.verifying.has(key)) throw Error('正在核对本次结果');
  this.verifying.add(key);
  try {
   const r=await this.api.result({id:state.id,activityEnrollmentId:state.enrollmentId,learningSessionId:state.sessionId});
   if(r?.code!==200) throw Error('结果暂时不可确认');
   const result=checkResult(r.data,state);
   let verified=false;
   if(['PASS','FAIL'].includes(result.status)) {
    const history=await this.api.history({id:state.id});
    verified=checkHistory(history,state,result);
   }
   const current=this.journal.get(key);
   if(current?.sessionId!==state.sessionId) throw Error('考试会话已经变更');
   if(current.phase==='verified') {if(!current.outcome) throw Error('已核验成绩暂不可读取');return {...current.outcome,verified:true};}
   if(!['submitting','accepted','submit-uncertain','pending'].includes(current.phase)&&!(orphaned&&current.phase==='active'&&!liveKeys.has(key))) throw Error('考试状态已经变更');
   this.journal.put(key,{...current,phase:verified?'verified':'pending',...(orphaned&&!verified?{lostSession:true}:{}),...(verified?{outcome:result}:{})});
   this.audit('verify',state,{status:result.status,verified,answerScore:result.answerScore});
   return {...result,verified};
  } finally {this.verifying.delete(key)}
 }
}
