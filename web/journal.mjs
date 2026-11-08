import {mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const digest=key=>createHash('sha256').update(key).digest('hex');
export const archiveKey=state=>`archive:${state.userId}:${state.id}:${state.sessionId}`;
const phases=new Set(['opening','open-uncertain','active','submitting','submit-uncertain','accepted','pending','verified']);
function validate(value){
 const allowed=['userId','id','activityId','enrollmentId','sessionId','phase','outcome','lostSession'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||!phases.has(value.phase)||['userId','id','activityId','enrollmentId'].some(k=>typeof value[k]!=='string'||!value[k])) throw Error('状态记录格式无效');
 if(!['opening','open-uncertain'].includes(value.phase)&&(typeof value.sessionId!=='string'||!value.sessionId)) throw Error('状态记录缺少会话');
 if(value.lostSession!==undefined&&typeof value.lostSession!=='boolean')throw Error('会话状态格式无效');
 if(value.outcome){
  const outcome=value.outcome;
  if(value.phase!=='verified'||typeof outcome!=='object'||Array.isArray(outcome)||Object.keys(outcome).some(k=>!['status','answerScore','score','passScore'].includes(k))||!['PASS','FAIL'].includes(outcome.status)||['answerScore','score','passScore'].some(k=>outcome[k]!=null&&(typeof outcome[k]!=='number'||!Number.isFinite(outcome[k])))) throw Error('成绩记录格式无效');
 }
}
/** Fail closed on unreadable state; never store tokens, answers, or credentials. */
export class Journal {
 constructor(path) {
  this.path=path;mkdirSync(dirname(path),{recursive:true,mode:0o700});
  try {const parsed=JSON.parse(readFileSync(path,'utf8'));if(parsed.version!==1||!parsed.records||Array.isArray(parsed.records)||typeof parsed.records!=='object')throw Error('invalid journal');for(const [key,value] of Object.entries(parsed.records)){if(!/^[a-f0-9]{64}$/.test(key))throw Error('invalid journal key');validate(value)}this.records=parsed.records;}
  catch(e){if(e.code==='ENOENT')this.records={};else throw Error('考试状态记录不可读取，已停止写操作');}
 }
 get(key){const value=this.records[digest(key)];return value?structuredClone(value):undefined;}
 archivesFor(context){
  return Object.entries(this.records).filter(([hash,value])=>value.userId===context.userId&&value.id===context.id&&value.activityId===context.activityId&&value.enrollmentId===context.enrollmentId&&value.sessionId&&hash===digest(archiveKey(value))).map(([hash,value])=>({handle:hash,state:structuredClone(value)}));
 }
 put(key,value){
  validate(value);
  const next={...this.records,[digest(key)]:structuredClone(value)};
  this.#commit(next);
 }
 startAttempt(key,value){
  validate(value);
  const previous=this.get(key);
  if(!previous){this.put(key,value);return}
  if(previous.phase!=='verified'||!previous.outcome||!previous.sessionId||value.phase!=='opening'||['userId','id','activityId','enrollmentId'].some(k=>previous[k]!==value[k]))throw Error('上次考试记录不能安全保存');
  const hash=digest(archiveKey(previous));
  if(this.records[hash])throw Error('上次考试记录已存在');
  this.#commit({...this.records,[hash]:previous,[digest(key)]:structuredClone(value)});
 }
 archiveAndPromote(key,candidate){
  const current=this.get(key);validate(candidate);
  if(!current||current.phase!=='pending'||candidate.phase!=='verified'||!candidate.outcome||current.sessionId===candidate.sessionId||['userId','id','activityId','enrollmentId'].some(k=>current[k]!==candidate[k])) throw Error('会话不满足归档条件');
  const oldKey=archiveKey(current),oldHash=digest(oldKey);
  if(this.records[oldHash]) throw Error('原会话已归档');
  this.#commit({...this.records,[oldHash]:structuredClone(current),[digest(key)]:structuredClone(candidate)});
 }
 archivePending(key){
  const current=this.get(key);
  if(!current||current.phase!=='pending'||!current.sessionId)throw Error('原会话尚不能安全归档');
  const oldHash=digest(archiveKey(current));if(this.records[oldHash])throw Error('原会话已归档');
  const next={...this.records,[oldHash]:structuredClone(current)};delete next[digest(key)];this.#commit(next);
 }
 archiveUncertainOpen(key){
  const current=this.get(key);
  if(!current||current.phase!=='open-uncertain'||current.sessionId)throw Error('当前开考状态不能归档');
  const oldHash=digest(`uncertain-open:${key}:${randomBytes(16).toString('hex')}`);
  const next={...this.records,[oldHash]:structuredClone(current)};delete next[digest(key)];this.#commit(next);
 }
 #commit(next){
  const temp=`${this.path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd=openSync(temp,'wx',0o600);
  try {writeFileSync(fd,JSON.stringify({version:1,records:next}));fsyncSync(fd);}finally{closeSync(fd)}
  renameSync(temp,this.path);
  const dir=openSync(dirname(this.path),'r');try{fsyncSync(dir)}finally{closeSync(dir)}
  this.records=next;
 }
}
