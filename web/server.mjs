import http from 'node:http';
import { randomBytes, createCipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePaper } from './answer-engine.mjs';
import { ExamFlow, checkAttempt, checkFace, checkSchedule, checkHistory, checkResult, isSupersededLogin } from './exam-flow.mjs';
import { Journal,archiveKey } from './journal.mjs';
import { parseLosslessJson } from './lossless-json.mjs';
import { runExam } from './exam-orchestrator.mjs';
const origin = process.env.LEARN_UPSTREAM || 'https://learning01.zzmetro.cn:30426';
const testTimeout=Number(process.env.LEARN_TEST_TIMEOUT_MS);
const upstreamTimeout=/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)&&Number.isInteger(testTimeout)&&testTimeout>=50&&testTimeout<=10000?testTimeout:15000;
const sessions = new Map();
const examJobs = new Map();
const userHasJob=userId=>[...examJobs.values()].some(job=>job.userId===userId&&job.running);
let journal;
try { journal=new Journal(process.env.LEARN_JOURNAL || '/root/learn/state/exams.json'); } catch { journal=null; }
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const basePath = process.env.BASE_PATH || '/';
const publicBasePath = process.env.PUBLIC_BASE_PATH || '/zgxy/';
const examPublicOrigin = process.env.EXAM_PUBLIC_ORIGIN || 'https://learn.ciphera.top';
const examPublicHost = new URL(examPublicOrigin).host;
const examSsoRedeemUrl = process.env.EXAM_SSO_REDEEM_URL || `${examPublicOrigin}/exam-sso/redeem`;
const examSsoSecretFile = process.env.EXAM_SSO_SECRET_FILE || '/root/learn/state/exam-sso.key';
const types = {html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',woff2:'font/woff2'};
function encrypt(value) { const key = Buffer.from('efthhgl9'); const cipher = createCipheriv('des-ede3', Buffer.concat([key,key,key]), null); return Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('hex'); }
async function body(req,limit=16384) { let s=''; for await(const part of req) { s+=part; if(s.length>limit) throw Error('请求过大'); } return JSON.parse(s || '{}'); }
async function formBody(req) { if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String(req.headers['content-type']||''))) throw Error('请求格式无效'); let s=''; for await(const part of req) { s+=part; if(s.length>8192) throw Error('请求过大'); } const params=new URLSearchParams(s), out={}; for(const key of params.keys()) if(!['ticket','training','group'].includes(key)) throw Error('请求格式无效'); for(const key of ['ticket','training']) { const values=params.getAll(key); if(values.length!==1) throw Error('请求格式无效'); out[key]=values[0]; } const groups=params.getAll('group');if(groups.length>1)throw Error('请求格式无效');out.group=groups[0]||'';return out; }
function json(res,status,data,headers={}) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}); res.end(JSON.stringify(data)); }
function ssoError(res,status,message) { const safe=String(message).replace(/[&<>"']/g,value=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value])); const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>考试入口</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;background:#fff;color:#292929;font:14px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(560px,calc(100% - 40px));padding:24px}p{margin:0}</style><main><p role="status">${safe}</p></main></html>`; res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'"}); res.end(html); }
async function upstream(path,data,token) {
 const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json; charset=UTF-8', ...(token ? {'X-Auth-Token':'Bearer '+token}: {})},body:JSON.stringify(data),signal:AbortSignal.timeout(upstreamTimeout)});
 const raw=await response.text(); if(!response.ok) throw Error(`平台 HTTP ${response.status}`);
 let parsed;try { parsed=parseLosslessJson(raw); } catch { throw Error('平台返回了无法解析的数据'); }
 if(path!=='/gateway/activity/api/activity-resource/open-evaluation-resource'&&isSupersededLogin(parsed))throw Object.assign(Error('登录状态已失效，请重新登录后重试'),{code:'PLATFORM_AUTH_EXPIRED'});
 return parsed;
}
async function verifiedExamOutcome(auth,exam) {
 const cached=auth.examOutcomeCache?.get(exam.id);
 if(cached&&cached.expires>Date.now())return cached.status;
 let status='UNKNOWN',hasFail=false;
 try {
  const detailResponse=await upstream('/gateway/exam/api/learn/paper/detail',{id:exam.id,resourceId:exam.resourceId,activityId:exam.id},auth.token);
  const detail=detailResponse.data;
  if(detailResponse.code!==200||!detail||typeof detail.id!=='string'||typeof detail.activityId!=='string'||typeof detail.activityEnrollmentId!=='string'||(exam.activityId!=null&&String(exam.activityId)!==detail.activityId)||(exam.activityEnrollmentId!=null&&String(exam.activityEnrollmentId)!==detail.activityEnrollmentId))throw Error('考项身份无法确认');
  const current=auth.exams.get(exam.id);
  auth.exams.set(exam.id,{...current,id:exam.id,resourceId:exam.resourceId,detailId:detail.id,activityId:detail.activityId,enrollmentId:detail.activityEnrollmentId});
  const history=await upstream('/gateway/activity/api/resource/paper-historical-achievements',{id:detail.id},auth.token);
  const rows=Array.isArray(history.data)?history.data:history.data?.paperRecordList;
  if(history.code!==200||!Array.isArray(rows))throw Error('历史成绩结构无法确认');
  const context={id:detail.id,activityId:detail.activityId,enrollmentId:detail.activityEnrollmentId};
  for(const row of rows){
   const sessionId=row?.learningSessionId;
   if(typeof sessionId!=='string'||!sessionId)continue;
   for(const [object,field,expected] of [[history.data,'id',context.id],[history.data,'activityEnrollmentId',context.enrollmentId],[history.data,'activityId',context.activityId],[row,'resourceId',context.id],[row,'activityEnrollmentId',context.enrollmentId],[row,'activityId',context.activityId]])if(object?.[field]!=null&&String(object[field])!==expected)throw Error('历史会话身份不一致');
   try{
    const response=await upstream('/gateway/activity/api/resource/paper-record',{id:context.id,activityEnrollmentId:context.enrollmentId,learningSessionId:sessionId},auth.token);
    if(response.code!==200||!response.data||typeof response.data!=='object')continue;
    const result=checkResult(response.data,{...context,sessionId});
    if(!['PASS','FAIL'].includes(result.status)||!checkHistory(history,{...context,sessionId},result))continue;
    if(result.status==='PASS'){status='PASS';break}
    hasFail=true;
   }catch{}
  }
  if(status!=='PASS'&&hasFail)status='FAIL';
 }catch{}
 auth.examOutcomeCache?.set(exam.id,{status,expires:Date.now()+15000});
 return status;
}
async function mapLimit(items,limit,fn){
 const result=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const index=next++;if(index>=items.length)return;result[index]=await fn(items[index],index)}}));
 return result;
}
function session(req) { const id=(req.headers.cookie||'').match(/(?:^|;\s*)learn_session=([a-f0-9]+)/)?.[1]; const entry=sessions.get(id); if(entry && Date.now()-entry.created < 3600000) return {id,...entry}; if(entry)entry.flow?.discardLive(); if(id) sessions.delete(id); return null; }
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');
  if(req.method==='POST'&&url.pathname==='/sso') {
   if(url.search||(req.headers.origin&&req.headers.origin!=='null'&&req.headers.origin!==examPublicOrigin)||req.headers.host!==examPublicHost||req.headers['x-exam-proxy']!==examPublicHost) return ssoError(res,403,'考试入口校验失败，请返回课程看板重新进入。');
   let input;try{input=await formBody(req)}catch{return ssoError(res,400,'考试入口无效，请返回课程看板重新进入。')}
   const ticket=input.ticket,training=input.training.trim(),group=input.group;
   if(!/^[a-f0-9]{64}$/.test(ticket)||!training||training.length>160||/[\u0000-\u001f\u007f]/.test(training)||(group&&!/^[A-Za-z0-9_-]{43}$/.test(group))) return ssoError(res,400,'考试入口无效，请返回课程看板重新进入。');
   let secret;try{secret=(await readFile(examSsoSecretFile,'utf8')).trim()}catch{return ssoError(res,503,'考试入口暂不可用，请稍后重试。')}
   if(!/^[a-f0-9]{64}$/.test(secret)) return ssoError(res,503,'考试入口暂不可用，请稍后重试。');
   const timestamp=String(Math.floor(Date.now()/1000));
   const signature=createHmac('sha256',secret).update(`POST\n/exam-sso/redeem\n${timestamp}\n${ticket}`,'utf8').digest('hex');
   let response;try{response=await fetch(examSsoRedeemUrl,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','X-Exam-Sso-Timestamp':timestamp,'X-Exam-Sso-Signature':signature},body:JSON.stringify({ticket}),signal:AbortSignal.timeout(8000)})}catch{return ssoError(res,503,'暂时无法连接课程站，请稍后重试。')}
   if(response.status!==200) return ssoError(res,response.status===410?410:503,response.status===410?'考试入口已失效，请关闭后从课程看板重新进入。':'暂时无法完成考试登录衔接，请关闭后重试。');
   let bundle;try{bundle=await response.json()}catch{return ssoError(res,503,'暂时无法完成考试登录衔接，请关闭后重试。');}
   if(typeof bundle.token!=='string'||bundle.token.length<12||bundle.token.length>4096||/[\u0000-\u001f\u007f]/.test(bundle.token)||typeof bundle.userId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(bundle.userId)) return ssoError(res,503,'暂时无法完成考试登录衔接，请关闭后重试。');
   const previous=session(req);if(previous&&userHasJob(previous.userId))return ssoError(res,409,'该账号已有考试正在进行，请返回原考试页面处理。');
   const token=bundle.token,userId=bundle.userId,id=randomBytes(32).toString('hex');
   const api={open:data=>upstream('/gateway/activity/api/activity-resource/open-evaluation-resource',data,token),submit:data=>upstream('/gateway/activity/api/activity-resource/submits-evaluation-resource',data,token),result:data=>upstream('/gateway/activity/api/resource/paper-record',data,token),history:data=>upstream('/gateway/activity/api/resource/paper-historical-achievements',data,token)};
   const sameUser=!!previous&&previous.userId===userId;
   const audit=(event,state,details)=>console.info(JSON.stringify({examEvent:event,sessionRef:createHash('sha256').update(JSON.stringify([state.userId,state.id,state.sessionId])).digest('hex'),...details}));
   let flow=journal?(sameUser&&previous.flow?previous.flow:new ExamFlow({journal,api,audit})):null;
   if(flow)flow.api=api;
   if(previous){if(!sameUser)previous.flow?.discardLive();sessions.delete(previous.id)}
   sessions.set(id,{token,userId,created:Date.now(),exams:sameUser?previous.exams:new Map(),history:sameUser?previous.history:new Map(),examOutcomeCache:sameUser?(previous.examOutcomeCache||new Map()):new Map(),flow});
   const root=publicBasePath.startsWith('/')&&publicBasePath.endsWith('/')&&!publicBasePath.includes('..')?publicBasePath:'/zgxy/';
   const target=new URL(root,examPublicOrigin);target.searchParams.set('training',training);target.searchParams.set('frame','1');if(group)target.searchParams.set('group',group);
   const protocol=req.headers['x-forwarded-proto']==='https'?'https':'http';
   return res.writeHead(303,{'Location':target.pathname+target.search,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`learn_session=${id}; HttpOnly; SameSite=Strict; Path=${basePath}; Max-Age=3600${protocol==='https'?'; Secure':''}`}).end();
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/')) {
   const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
   if(req.headers.origin && req.headers.origin!==`${protocol}://${req.headers.host}`) return json(res,403,{error:'来源不匹配'});
   if(url.pathname==='/api/login') {
    const previous=session(req);if(previous&&userHasJob(previous.userId))return json(res,409,{error:'考试正在进行，请稍后重新登录'});
    const input=await body(req); if(![input.orgCode,input.username,input.password].every(v=>typeof v==='string'&&v.length>0&&v.length<=512)) return json(res,400,{error:'请填写组织代码、账号和密码'});
    const result=await upstream('/gateway/organization/api/open/login/encrypt/loginByAccount',{orgCode:encrypt(input.orgCode),username:encrypt(input.username),password:encrypt(input.password),openId:null,userInfo:null,platform:'Android'});
    if(result.code!==200 || !result.data?.token) return json(res,401,{error:result.message || '平台登录失败',code:result.code});
    const old=session(req);
    const id=randomBytes(32).toString('hex'); const token=result.data.token;
    const api={open:data=>upstream('/gateway/activity/api/activity-resource/open-evaluation-resource',data,token),submit:data=>upstream('/gateway/activity/api/activity-resource/submits-evaluation-resource',data,token),result:data=>upstream('/gateway/activity/api/resource/paper-record',data,token),history:data=>upstream('/gateway/activity/api/resource/paper-historical-achievements',data,token)};
    const userId=result.data.user?.id;const sameUser=!!old&&typeof userId==='string'&&old.userId===userId;
    const audit=(event,state,details)=>console.info(JSON.stringify({examEvent:event,sessionRef:createHash('sha256').update(JSON.stringify([state.userId,state.id,state.sessionId])).digest('hex'),...details}));
    let flow=journal?(sameUser&&old.flow?old.flow:new ExamFlow({journal,api,audit})):null;
    if(flow)flow.api=api;
    if(old){if(!sameUser)old.flow?.discardLive();sessions.delete(old.id)}
    sessions.set(id,{token,userId,created:Date.now(),exams:sameUser?old.exams:new Map(),history:sameUser?old.history:new Map(),examOutcomeCache:sameUser?(old.examOutcomeCache||new Map()):new Map(),flow});
    return json(res,200,{ok:true},{'Set-Cookie':`learn_session=${id}; HttpOnly; SameSite=Strict; Path=${basePath}; Max-Age=3600${protocol === 'https' ? '; Secure' : ''}`});
   }
   const auth=session(req); if(!auth) return json(res,401,{error:'请先登录'});
   if(url.pathname==='/api/session') return json(res,200,{authenticated:true});
   if(url.pathname==='/api/exam-course-context') {
    const input=await body(req,65536),ticket=input.ticket;
    if(typeof ticket!=='string'||ticket.length>60000||!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket))return json(res,400,{error:'课程考试信息无效'});
    const [encoded,signature]=ticket.split('.');let secret;
    try{secret=(await readFile(examSsoSecretFile,'utf8')).trim()}catch{return json(res,503,{error:'课程考试暂不可用'})}
    if(!/^[a-f0-9]{64}$/.test(secret))return json(res,503,{error:'课程考试暂不可用'});
    const expected=createHmac('sha256',secret).update('exam-context\n'+encoded).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return json(res,403,{error:'课程考试信息无法核对'});
    let value;try{value=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'))}catch{return json(res,400,{error:'课程考试信息无效'})}
    const now=Math.floor(Date.now()/1000);
    if(!value||value.sub!==createHash('sha256').update(auth.userId).digest('hex')||!Number.isInteger(value.exp)||value.exp<now||value.exp>now+120||typeof value.group!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.group)||!Array.isArray(value.records)||value.records.length>20)return json(res,403,{error:'课程考试信息已失效'});
    const records=[];const seen=new Set();
    for(const row of value.records){
     if(!row||typeof row.activityId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(row.activityId)||typeof row.resourceId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(row.resourceId)||typeof row.title!=='string'||row.title.length>160||/[\u0000-\u001f\u007f]/.test(row.title))return json(res,400,{error:'课程考试信息无效'});
     const handle='course:'+createHash('sha256').update(JSON.stringify([row.activityId,row.resourceId])).digest('hex');
     if(seen.has(handle))return json(res,400,{error:'课程考试信息重复'});seen.add(handle);
     const previous=auth.exams.get(handle);auth.exams.set(handle,{...previous,id:row.activityId,resourceId:row.resourceId,title:row.title});
     records.push({id:handle,title:row.title});
    }
    return json(res,200,{group:value.group,records});
   }
   if(url.pathname==='/api/logout') { if(userHasJob(auth.userId))return json(res,409,{error:'考试正在进行，请稍后退出'});auth.flow?.discardLive();sessions.delete(auth.id); return json(res,200,{ok:true},{'Set-Cookie':`learn_session=; HttpOnly; SameSite=Strict; Path=${basePath}; Max-Age=0${protocol === 'https' ? '; Secure' : ''}`}); }
   if(['/api/exam-run-start','/api/exam-run-status'].includes(url.pathname)) {
    const input=await body(req),exam=auth.exams.get(input.id);
    if(!auth.flow||typeof auth.userId!=='string'||!exam?.detailId) return json(res,400,{error:'请先读取该考试详情'});
    const key=JSON.stringify([auth.userId,exam.detailId]),existing=examJobs.get(key);
    if(url.pathname==='/api/exam-run-status') return json(res,200,existing?{running:existing.running,message:existing.message,result:existing.result??null}: {running:false,message:'',result:null});
    if(input.confirmed!==true) return json(res,400,{error:'需要确认自动考试'});
    if(existing?.running)return json(res,409,{error:'该考试正在进行'});
    if(userHasJob(auth.userId))return json(res,409,{error:'另一场考试正在进行'});
    const saved=sessions.get(auth.id);if(!saved)return json(res,401,{error:'请先登录'});saved.created=Date.now();
    saved.examOutcomeCache?.delete(input.id);
    for(const [k,j] of examJobs)if(!j.running&&Date.now()-j.updated>3600000)examJobs.delete(k);
    const job={userId:auth.userId,running:true,message:'正在准备考试…',updated:Date.now()};examJobs.set(key,job);
    const call=async(path,data={})=>{
     const response=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:`learn_session=${auth.id}`},body:JSON.stringify({id:input.id,...data})});
     const value=await response.json();if(!response.ok){const error=Error(value.error||'请求失败');error.phase=value.phase;throw error}return value;
    };
    void runExam({call,allowRecovery:input.recoverLost===true,allowOpenRecovery:input.confirmedPlatformPending===true,report:({message})=>{job.message=message;job.updated=Date.now()}}).then(value=>{job.result=value.result;job.message=value.message},error=>{job.message=error.message||'考试未完成'}).finally(()=>{saved.examOutcomeCache?.delete(input.id);job.running=false;job.updated=Date.now()});
    return json(res,200,{running:true,message:job.message});
   }
   if(url.pathname==='/api/exams') {
    const input=await body(req); const page=Number(input.page || 1); if(!Number.isInteger(page)||page<1||page>1000) return json(res,400,{error:'页码无效'});
    if(input.refresh===true)auth.examOutcomeCache?.clear();
    const finished=input.finished===1?1:0;
    const getBucket=async bucket=>{
     const response=await upstream('/gateway/exam/api/learn/get-training-exam',{page,limit:20,params:{finished:bucket,type:'EXAM'}},auth.token);
     if(response.code!==200)throw Error(response.message||'考试列表获取失败');
     const content=response.data?.content;if(!Array.isArray(content?.records)||!Number.isInteger(Number(content.pages))||!Number.isInteger(Number(content.current)))throw Error('考试列表响应结构与 APK 不一致');
     for(const exam of content.records)if(typeof exam.id==='string'&&typeof exam.resourceId==='string'){
      const previous=auth.exams.get(exam.id);auth.exams.set(exam.id,previous?.resourceId===exam.resourceId?{...previous,...exam,id:exam.id,resourceId:exam.resourceId}:{...exam,id:exam.id,resourceId:exam.resourceId});
     }
     return content;
    };
    let records=[],pages=1,current=page;
    if(finished){
     const content=await getBucket(1);pages=Math.max(1,Number(content.pages));current=Number(content.current)||page;
     const checks=await mapLimit(content.records,4,async exam=>({exam,status:await verifiedExamOutcome(auth,exam)}));
     records=checks.filter(item=>item.status==='PASS').map(item=>({...item.exam,status:'PASS',finished:true}));
    }else{
     const [pending,completed]=await Promise.all([getBucket(0),getBucket(1)]);
     pages=Math.max(1,Number(pending.pages),Number(completed.pages));current=page;
     const pendingRows=pending.records.map(exam=>({exam,source:0}));
     const completedRows=completed.records.map(exam=>({exam,source:1}));
     const candidates=[...pendingRows,...completedRows];
     const checks=await mapLimit(candidates,4,async ({exam,source})=>{
      const value=source===1||exam.finished===true||['COMPLETED','PASS','FAIL'].includes(String(exam.status||exam.attendanceStatus||'').toUpperCase())?await verifiedExamOutcome(auth,exam):'PENDING';
      return {exam,status:value};
     });
     const unique=new Map();
     for(const item of checks){
      const {exam,status}=item;if(typeof exam.id!=='string')continue;
      if(status==='PASS')continue;
      const displayStatus=status==='FAIL'?'FAIL':status==='UNKNOWN'?'UNKNOWN':exam.status||exam.attendanceStatus||'NOT_STARTED';
      if(!unique.has(exam.id)||status==='FAIL')unique.set(exam.id,{...exam,status:displayStatus,finished:status!=='PENDING'});
     }
     records=[...unique.values()];
    }
    return json(res,200,{records,pages,current});
   }
   if(url.pathname==='/api/exam-detail') {
    const input=await body(req); const exam=auth.exams.get(input.id);
    if(!exam) return json(res,400,{error:'请先从当前账号的考试列表选择考试'});
    const result=await upstream('/gateway/exam/api/learn/paper/detail',{id:exam.id,resourceId:exam.resourceId,activityId:exam.id},auth.token);
    if(result.code!==200 || !result.data || typeof result.data!=='object') return json(res,502,{error:result.message||'试卷详情获取失败'});
    const d=result.data;
    if(input.id.startsWith('course:')&&(d.id!==exam.resourceId||d.activityId!==exam.id))return json(res,409,{error:'课程考试身份不一致'});
    if(typeof d.id==='string' && d.id) auth.exams.set(input.id,{...exam,detailId:d.id,activityId:d.activityId,enrollmentId:d.activityEnrollmentId});
    return json(res,200,{detail:{title:d.title||d.name||'',id:d.id,activityId:d.activityId,attempt:d.attempt,myAttempt:d.myAttempt,questionNum:d.questionNum,score:d.score,passScore:d.passScore,time:d.time,description:d.description}});
   }
   if(url.pathname==='/api/exam-preflight') {
    const input=await body(req);const exam=auth.exams.get(input.id);
    if(!exam?.detailId) return json(res,400,{error:'请先读取该考试的详情'});
    const detail=await upstream('/gateway/exam/api/learn/paper/detail',{id:exam.id,resourceId:exam.resourceId,activityId:exam.id},auth.token);
    if(detail.code!==200||!detail.data||detail.data.id!==exam.detailId) return json(res,409,{error:'考试详情身份无法核对'});
    const face=await upstream('/gateway/organization/api/recognition/getFaceCheckConfig',{},auth.token);
    const config=face.data?.faceCheckConfig;const d=detail.data;
    const reasons=[];
    if(face.code!==200) reasons.push('无法读取人脸验证策略'); else try{checkFace(config)}catch(e){reasons.push(e.message)}
    try{checkAttempt(d)}catch(e){reasons.push(e.message)}
    try{checkSchedule(d)}catch(e){reasons.push(e.message)}
    if(typeof d.activityId!=='string'||!d.activityId||typeof d.activityEnrollmentId!=='string'||!d.activityEnrollmentId) reasons.push('活动或报名身份不完整');
    if(!auth.flow) reasons.push('考试状态记录不可用');
    return json(res,200,{ready:reasons.length===0,reasons,faceRequired:typeof config?.faceInd==='boolean'?config.faceInd:null,attempt:d.attempt,remaining:d.myAttempt});
   }
   if(url.pathname==='/api/exam-audit') {
    const input=await body(req);const exam=auth.exams.get(input.id);
    if(!auth.flow||!exam?.detailId||typeof auth.userId!=='string') return json(res,400,{error:'请先读取当前账号的考试详情'});
    const state=journal.get(auth.flow.key(auth.userId,exam.detailId));
    if(!state||state.id!==exam.detailId||state.activityId!==exam.activityId||state.enrollmentId!==exam.enrollmentId||!state.sessionId) return json(res,409,{error:'没有可核对的原考试会话'});
    const [detail,record]=await Promise.all([
     upstream('/gateway/exam/api/learn/paper/detail',{id:exam.id,resourceId:exam.resourceId,activityId:exam.id},auth.token),
     upstream('/gateway/activity/api/resource/paper-record',{id:state.id,activityEnrollmentId:state.enrollmentId,learningSessionId:state.sessionId},auth.token)
    ]);
    if(detail.code!==200||detail.data?.id!==state.id||detail.data?.activityId!==state.activityId||detail.data?.activityEnrollmentId!==state.enrollmentId||record.code!==200||!record.data||typeof record.data!=='object') return json(res,502,{error:'无法核对原考试响应'});
    for(const [field,expected] of [['id',state.id],['resourceId',state.id],['activityEnrollmentId',state.enrollmentId],['learningSessionId',state.sessionId]]) if(record.data[field]!=null&&String(record.data[field])!==expected) return json(res,409,{error:'原会话响应身份冲突'});
    const shape=x=>({fields:Object.keys(x),papers:Array.isArray(x.papers)?x.papers.length:null,questionRecords:Array.isArray(x.questionRecords)?x.questionRecords.length:null,hasLearningToken:typeof x.learningToken==='string'&&x.learningToken.length>0});
    return json(res,200,{phase:state.phase,detail:shape(detail.data),record:shape(record.data),attendanceStatus:record.data.attendanceStatus??null});
   }
   if(['/api/exam-prior','/api/exam-prior-verify'].includes(url.pathname)) {
    const input=await body(req);const exam=auth.exams.get(input.id);
    if(!auth.flow||typeof auth.userId!=='string'||!exam?.detailId) return json(res,400,{error:'请先读取当前账号的考试详情'});
    const archives=journal.archivesFor({userId:auth.userId,id:exam.detailId,activityId:exam.activityId,enrollmentId:exam.enrollmentId});
    if(url.pathname==='/api/exam-prior') return json(res,200,{records:archives.map(({handle,state})=>({handle,phase:state.phase,outcome:state.phase==='verified'?state.outcome??null:null}))});
    const prior=archives.find(x=>x.handle===input.handle);
    if(!prior) return json(res,404,{error:'没有找到该历史会话'});
    try{return json(res,200,await auth.flow.verify(archiveKey(prior.state)))}catch(e){return json(res,409,{error:e.message||'历史会话结果未确认'})}
   }
   if(['/api/exam-open','/api/exam-prepare','/api/exam-diagnostics','/api/exam-answer-check','/api/exam-submit','/api/exam-submit-discovery','/api/exam-submit-partial','/api/exam-verify','/api/exam-state','/api/exam-archive-pending','/api/exam-archive-uncertain-open'].includes(url.pathname)) {
    const input=await body(req);const exam=auth.exams.get(input.id);
    if(!auth.flow||typeof auth.userId!=='string') return json(res,503,{error:'考试状态记录不可用'});
    if(!exam?.detailId) return json(res,400,{error:'请先读取该考试详情'});
    const key=auth.flow.key(auth.userId,exam.detailId);
    const known=journal.get(key);
    if(known&&(known.activityId!==exam.activityId||known.enrollmentId!==exam.enrollmentId)) return json(res,409,{error:'该考试的活动或报名身份与已有会话不一致'});
    try {
     if(url.pathname==='/api/exam-state') return json(res,200,{...auth.flow.status(key),autoTwoRound:true});
     if(url.pathname==='/api/exam-archive-uncertain-open') {
      if(input.confirmed!==true) return json(res,400,{error:'请先确认官方平台显示待考试'});
      const detail=await upstream('/gateway/exam/api/learn/paper/detail',{id:exam.id,resourceId:exam.resourceId,activityId:exam.id},auth.token);
      const d=detail.data;
      if(detail.code!==200||!d||d.id!==exam.detailId||d.activityId!==exam.activityId||d.activityEnrollmentId!==exam.enrollmentId) return json(res,409,{error:'考试身份无法核对'});
      const history=await upstream('/gateway/activity/api/resource/paper-historical-achievements',{id:exam.detailId},auth.token);
      const rows=Array.isArray(history.data)?history.data:history.data?.paperRecordList;
      if(history.code!==200||!Array.isArray(rows))return json(res,409,{error:'暂时无法读取历史成绩'});
      if(!Array.isArray(history.data)) {
       for(const [field,expected] of [['id',exam.detailId],['activityEnrollmentId',exam.enrollmentId],['activityId',exam.activityId]])
        if(history.data?.[field]!=null&&String(history.data[field])!==expected)return json(res,409,{error:'历史记录身份无法核对'});
       if(history.data?.learningSessionId)return json(res,409,{error:'平台返回了考试会话，请先核对'});
      }
      auth.flow.archiveUncertainOpen(key);return json(res,200,{archived:true});
     }
     if(url.pathname==='/api/exam-archive-pending') {
      if(input.confirmed!==true) return json(res,400,{error:'需要确认保留旧会话并开始新考试'});
      auth.flow.archivePending(key);return json(res,200,{archived:true});
     }
     if(url.pathname==='/api/exam-open') {
      if(input.confirmed!==true) return json(res,400,{error:'需要确认开考'});
      const detail=await upstream('/gateway/exam/api/learn/paper/detail',{id:exam.id,resourceId:exam.resourceId,activityId:exam.id},auth.token);
      const d=detail.data;
      if(detail.code!==200||!d||d.id!==exam.detailId||d.activityId!==exam.activityId||d.activityEnrollmentId!==exam.enrollmentId) return json(res,409,{error:'考试身份发生变化，请重新打开详情'});
      const face=await upstream('/gateway/organization/api/recognition/getFaceCheckConfig',{},auth.token);
      if(face.code!==200) return json(res,409,{error:'无法读取人脸验证策略'});
      const opened=await auth.flow.open({userId:auth.userId,detail:d,face:face.data?.faceCheckConfig,confirmed:true});
      return json(res,200,{phase:'active',total:opened.total,remainingSeconds:opened.remainingSeconds});
     }
     if(url.pathname==='/api/exam-prepare'||url.pathname==='/api/exam-diagnostics'||url.pathname==='/api/exam-answer-check') {
      if(url.pathname==='/api/exam-prepare'&&input.confirmed!==true) return json(res,400,{error:'需要确认填答'});
      const review=[],wrongBank=[];
      for(const item of auth.history.values()) if(item.binding?.id===exam.detailId&&item.binding?.enrollmentId===exam.enrollmentId&&item.exam.activityId===exam.activityId) {
       if(Array.isArray(item.review)) review.push(...item.review);
       if(Array.isArray(item.wrongBank)) wrongBank.push(...item.wrongBank);
      }
      if(url.pathname==='/api/exam-diagnostics') return json(res,200,auth.flow.diagnostics(key,[...wrongBank,...review]));
      if(url.pathname==='/api/exam-answer-check') {const comparison=auth.flow.comparePrevious(key,{review,wrongBank});console.info(JSON.stringify({examEvent:'answer-check',...comparison}));return json(res,200,comparison);}
      const {preview,...summary}=auth.flow.prepare(key,{review,wrongBank});
      return json(res,200,summary);
     }
     if(url.pathname==='/api/exam-submit'||url.pathname==='/api/exam-submit-discovery'||url.pathname==='/api/exam-submit-partial') {
      if(input.confirmed!==true) return json(res,400,{error:'需要确认交卷'});
      const face=await upstream('/gateway/organization/api/recognition/getFaceCheckConfig',{},auth.token);
      if(face.code!==200) return json(res,409,{error:'无法读取人脸验证策略'});
      checkFace(face.data?.faceCheckConfig);
      const discovery=url.pathname!=='/api/exam-submit';
      return json(res,200,await auth.flow.submit(key,{confirmed:true,discovery,finalPartial:url.pathname==='/api/exam-submit-partial'}));
     }
     return json(res,200,await auth.flow.verify(key));
    } catch(e) {return json(res,e.code==='PLATFORM_AUTH_EXPIRED'?401:409,{error:e.message||'考试操作未完成',phase:journal.get(key)?.phase||'ready',...(Number.isSafeInteger(e.writeElapsedMs)?{elapsedMs:e.writeElapsedMs}:{})});}
   }
   if(url.pathname==='/api/exam-history') {
    const input=await body(req); const exam=auth.exams.get(input.id);
    if(!exam?.detailId) return json(res,400,{error:'请先读取该考试的详情'});
    const result=await upstream('/gateway/activity/api/resource/paper-historical-achievements',{id:exam.detailId},auth.token);
    if(result.code!==200) return json(res,502,{error:result.message||'历史成绩获取失败'});
    const rows=Array.isArray(result.data)?result.data:result.data?.paperRecordList;
    if(!Array.isArray(rows)) return json(res,502,{error:'历史成绩响应结构不符合预期'});
    const current=journal?.get(auth.flow?.key(auth.userId,exam.detailId));
    const records=rows.map(r=>{
     const handle=randomBytes(16).toString('hex');
     auth.history.set(handle,{exam,row:r,container:result.data});
     return {handle,current:!!current?.sessionId&&r.learningSessionId===current.sessionId,createdAt:r.createdAt,answerScore:r.answerScore,score:r.score,attendanceStatus:r.attendanceStatus,reviewRecordsInd:r.reviewRecordsInd};
    });
    return json(res,200,{records});
   }
   if(url.pathname==='/api/history-result') {
    const input=await body(req); const item=auth.history.get(input.handle);
    if(!item) return json(res,400,{error:'请先读取当前账号的历史记录'});
    const {exam,row,container}=item;
    const id=row.resourceId||container?.id||exam.detailId;
    const enrollmentId=row.activityEnrollmentId||container?.activityEnrollmentId||exam.enrollmentId;
    const sessionId=row.learningSessionId;
    if(typeof id!=='string'||id!==exam.detailId||typeof enrollmentId!=='string'||!enrollmentId||typeof sessionId!=='string'||!sessionId) return json(res,409,{error:'历史记录缺少可核对的考试或会话身份'});
    if(exam.enrollmentId && exam.enrollmentId!==enrollmentId) return json(res,409,{error:'报名身份不一致'});
    for(const [object,field,expected] of [[container,'id',exam.detailId],[container,'activityEnrollmentId',enrollmentId],[container,'activityId',exam.activityId],[row,'resourceId',exam.detailId],[row,'activityEnrollmentId',enrollmentId],[row,'activityId',exam.activityId]]) if(object?.[field]!=null && String(object[field])!==expected) return json(res,409,{error:'历史记录的考项或报名身份不一致'});
    const result=await upstream('/gateway/activity/api/resource/paper-record',{id,activityEnrollmentId:enrollmentId,learningSessionId:sessionId},auth.token);
    if(result.code!==200||!result.data||typeof result.data!=='object') return json(res,502,{error:result.message||'历史结果读取失败'});
    const d=result.data;
    for(const [key,value] of [['id',id],['resourceId',id],['activityEnrollmentId',enrollmentId],['learningSessionId',sessionId]]) if(d[key]!=null && String(d[key])!==value) return json(res,409,{error:'历史结果身份不一致'});
    let historyMatched;
    try {historyMatched=checkHistory({code:200,data:container},{id,enrollmentId,sessionId,activityId:exam.activityId},{status:d.attendanceStatus,answerScore:d.answerScore});} catch(e) {return json(res,409,{error:e.message});}
    if(!historyMatched) return json(res,409,{error:'历史记录中未找到唯一的原会话'});
    delete item.review;delete item.wrongBank;
    item.binding={id,enrollmentId,sessionId,attendanceStatus:d.attendanceStatus,paperDisplayAnswerMode:d.paperDisplayAnswerMode};
    return json(res,200,{result:{answerScore:d.answerScore,score:d.score,passScore:d.passScore,attendanceStatus:d.attendanceStatus,paperDisplayAnswerMode:d.paperDisplayAnswerMode,historyMatched}});
   }
   if(url.pathname==='/api/history-review') {
    const input=await body(req); const item=auth.history.get(input.handle); const b=item?.binding;
    if(!b) return json(res,400,{error:'请先核对该历史会话的结果'});
    if(!((b.attendanceStatus==='FAIL'&&b.paperDisplayAnswerMode==='FIRST')||(b.attendanceStatus==='PASS'&&['PASS','FIRST'].includes(b.paperDisplayAnswerMode)))) return json(res,403,{error:'平台策略不允许复核该会话'});
    const result=await upstream('/gateway/activity/api/learning/review-paper',{activityEnrollmentId:b.enrollmentId,resourceId:b.id,learningSessionId:b.sessionId},auth.token);
    if(result.code!==200||!Array.isArray(result.data)) return json(res,502,{error:result.message||'复核结果结构不符合预期'});
    for(const q of result.data) for(const [field,expected] of [['resourceId',b.id],['activityEnrollmentId',b.enrollmentId],['learningSessionId',b.sessionId],['activityId',item.exam.activityId]]) if(q[field]!=null&&String(q[field])!==expected) return json(res,409,{error:'复核结果中出现不属于当前会话的数据'});
    item.review=result.data;
    const shapes={},optionIndexAudit={compared:0,agree:0,disagree:0,unusable:0},answerAudit={answered:0,blank:0,unknown:0,correctStatus:{}};
    for(const q of result.data) {
     const type=String(q.questionType||'unknown');
     if(!shapes[type]) shapes[type]={count:0,questionAnswer:0,optionAnswer:0,optionFields:[]};
     const x=shapes[type];x.count++;
     const statusKey=String(q.correctStatus??'null');answerAudit.correctStatus[statusKey]=(answerAudit.correctStatus[statusKey]||0)+1;
     let answered=null;
     if(['S','M','C'].includes(type))answered=Array.isArray(q.myOption)?q.myOption.length>0:null;
     else if(['T','A'].includes(type))answered=q.myAnswer==null?false:String(q.myAnswer).trim().length>0;
     else if(type==='F')answered=Array.isArray(q.myFAnswer)?q.myFAnswer.some(x=>x!=null&&String(x).trim()):null;
     if(answered===true)answerAudit.answered++;else if(answered===false)answerAudit.blank++;else answerAudit.unknown++;
     if(q.questionAnswer!=null&&q.questionAnswer!=='') x.questionAnswer++;
     if(q.optionAnswer!=null&&q.optionAnswer!=='') x.optionAnswer++;
     if(Array.isArray(q.questionOptionList)&&q.questionOptionList[0]) x.optionFields=Object.keys(q.questionOptionList[0]);
     if(['S','M','C'].includes(q.questionType)&&Array.isArray(q.optionAnswer)&&Array.isArray(q.questionOptionList)) {
      const options=q.questionOptionList;
      if(options.every(o=>typeof o.correctInd==='boolean'&&Number.isInteger(o.index))&&new Set(options.map(o=>o.index)).size===options.length&&q.optionAnswer.every(Number.isInteger)) {
       const expected=options.filter(o=>o.correctInd).map(o=>o.index).sort((a,b)=>a-b),actual=[...q.optionAnswer].sort((a,b)=>a-b);
       optionIndexAudit.compared++;
       if(JSON.stringify(expected)===JSON.stringify(actual)) optionIndexAudit.agree++;else optionIndexAudit.disagree++;
      } else optionIndexAudit.unusable++;
     }
    }
    const reconstructed=result.data.map((q,index)=>({id:q.id,type:q.questionType,index,questionOptionList:Array.isArray(q.questionOptionList)?q.questionOptionList.map(o=>({id:o.id})):[]}));
    const coverage=resolvePaper(reconstructed,result.data);
    return json(res,200,{count:result.data.length,shapes,optionIndexAudit,answerAudit,coverage:{matched:coverage.matched,total:coverage.total,complete:coverage.complete}});
   }
   if(url.pathname==='/api/history-wrong-bank') {
    const input=await body(req);const item=auth.history.get(input.handle);const b=item?.binding;
    if(!b||typeof item.exam.activityId!=='string'||typeof auth.userId!=='string') return json(res,409,{error:'缺少已核对的会话、活动或账号身份'});
    if(!['PASS','FAIL'].includes(b.attendanceStatus)) return json(res,403,{error:'该会话尚未完成评分'});
    const all=[];let total=null,pageCount=null,explicitSession=0,explicitResource=0;
    for(let page=1;page<=200;page++) {
     const result=await upstream('/gateway/activity/api/wrong/get-answer-data/page',{page,limit:50,sort:'updated_at',order:'desc',params:{learningSessionId:b.sessionId,resourceId:b.id,activityId:item.exam.activityId,userId:auth.userId}},auth.token);
     const data=result.data;const count=Number(data?.total),pages=Number(data?.pages);
     const validInteger=v=>(typeof v==='number'&&Number.isSafeInteger(v))||(typeof v==='string'&&/^\d+$/.test(v)&&Number.isSafeInteger(Number(v)));
     if(![200,1].includes(result.code)||!Array.isArray(data?.records)||!validInteger(data?.total)||!validInteger(data?.pages)||count<0||pages<0||(data.current!=null&&Number(data.current)!==page)) return json(res,502,{error:'错题库响应结构不符合预期'});
     if(total!==null&&total!==count) return json(res,409,{error:'错题库分页数量发生变化'});
     if(pageCount!==null&&pageCount!==pages) return json(res,409,{error:'错题库页数发生变化'});
     total=count;pageCount=pages;
     for(const row of data.records) {
      for(const [key,expected] of [['resourceId',b.id],['learningSessionId',b.sessionId],['activityId',item.exam.activityId],['userId',auth.userId]]) if(row[key]!=null&&String(row[key])!==expected) return json(res,409,{error:'错题库返回了不属于当前上下文的数据'});
      if(row.learningSessionId!=null) explicitSession++;
      if(row.resourceId!=null) explicitResource++;
      all.push(row);
     }
     if(page>=pages) break;
    }
    if(all.length!==total) return json(res,409,{error:'错题库分页不完整'});
    const attribution=all.length===0?'empty':explicitSession===all.length&&explicitResource===all.length?'explicit':explicitResource===all.length?'resource':'unconfirmed';
    item.wrongBank=['explicit','resource'].includes(attribution)?all:[];
    const bankQuestions=all.map((q,index)=>({id:q.id,type:q.questionType,index,questionOptionList:Array.isArray(q.questionOptionList)?q.questionOptionList.map(o=>({id:o.id})):[]}));
    const readable=resolvePaper(bankQuestions,[],all).matched;
    return json(res,200,{count:all.length,acceptedCount:item.wrongBank.length,readable,fields:all.length?Object.keys(all[0]):[],attribution});
   }
   if(url.pathname==='/api/history-crosscheck') {
    const input=await body(req);
    if(!Array.isArray(input.handles)||!input.handles.length||input.handles.length>3||new Set(input.handles).size!==input.handles.length) return json(res,400,{error:'请选择一至三个历史会话'});
    const items=input.handles.map(handle=>auth.history.get(handle));const first=items[0];
    if(!first?.binding||!Array.isArray(first.review)||items.some(item=>!item?.binding||item.binding.id!==first.binding.id||item.binding.enrollmentId!==first.binding.enrollmentId||item.exam.activityId!==first.exam.activityId||!Array.isArray(item.review))) return json(res,409,{error:'复核会话尚未读取或不属于同一考项'});
    const questions=first.review.map((q,index)=>({id:q.id,type:q.questionType,index,questionOptionList:Array.isArray(q.questionOptionList)?q.questionOptionList.map(o=>({id:o.id})):[]}));
    const result=resolvePaper(questions,items.flatMap(item=>item.review),items.flatMap(item=>item.wrongBank||[]));
    return json(res,200,{matched:result.matched,total:result.total,complete:result.complete});
   }
   if(url.pathname==='/api/history-bank-audit') {
    const input=await body(req);const item=auth.history.get(input.handle);
    if(!item?.binding||!Array.isArray(item.wrongBank)) return json(res,400,{error:'请先核对历史结果并读取本次错题'});
    const bank=item.wrongBank;
    const questions=bank.map((q,index)=>({id:q.id,type:q.questionType,index,questionOptionList:Array.isArray(q.questionOptionList)?q.questionOptionList.map(o=>({id:o.id})):[]}));
    const own=resolvePaper(questions,[],bank);
    let cross=null;
    if(Array.isArray(item.review)) {
     const reviewIds=new Set(item.review.map(q=>`${q.id}\0${q.questionType}`));
     const shared=questions.filter(q=>reviewIds.has(`${q.id}\0${q.type}`));
     let agreed=0,conflict=0,unresolved=0;
     for(const question of shared){
      const a=resolvePaper([question],[],bank),b=resolvePaper([question],item.review,[]);
      if(!a.complete||!b.complete){unresolved++;continue}
      const signature=r=>JSON.stringify({...r,...(r.optionRecords?{optionRecords:[...r.optionRecords].sort((x,y)=>x.optionId.localeCompare(y.optionId))}:{})});
      if(signature(a.records[0])===signature(b.records[0])) agreed++;else conflict++;
     }
     cross={shared:shared.length,total:questions.length,agreed,conflict,unresolved};
    }
    return json(res,200,{count:bank.length,readable:own.matched,cross});
   }
   return json(res,404,{error:'接口不存在'});
  }
  if(req.method!=='GET') return json(res,405,{error:'不支持的方法'});
  const file=({'/':'index.html','/style.css':'style.css','/app.js':'app.js','/frame.js':'frame.js','/fonts/ark-pixel-zh-hans.woff2':'fonts/ark-pixel-zh-hans.woff2','/fonts/ark-pixel-latin.woff2':'fonts/ark-pixel-latin.woff2','/fonts/fusion-pixel-12px-zh-hans.woff2':'fonts/fusion-pixel-12px-zh-hans.woff2'})[url.pathname]; if(!file) return json(res,404,{error:'未找到'});
  const data=await readFile(publicDir+file);res.writeHead(200,{'Content-Type':types[file.split('.').pop()],'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"});res.end(data);
 } catch(e) { json(res,e.code==='PLATFORM_AUTH_EXPIRED'?401:502,{error:e.code==='PLATFORM_AUTH_EXPIRED'?'登录状态已失效，请重新登录后重试':e.name==='TimeoutError'?'平台请求超时': '请求失败，请检查平台连接或稍后重试'}); }
});
const port=Number(process.env.PORT||4174); server.listen(port,'127.0.0.1',()=>console.log(`学习托管初版 http://127.0.0.1:${port}`));
