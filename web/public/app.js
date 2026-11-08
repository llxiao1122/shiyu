const $=s=>document.querySelector(s); let page=0,pages=1,finished=0,activeTimer=null,listVersion=0;const automationRuns=new Set();const params=new URLSearchParams(location.search);const courseContext=(params.get('training')||'').trim().slice(0,160);const frameMode=params.get('frame')==='1';
const courseGroup=/^[A-Za-z0-9_-]{43}$/.test(params.get('group')||'')?params.get('group'):'';
const preloadMode=frameMode&&courseContext==='__exam_preload__';
if(preloadMode){try{for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith('exam-prefetch:'))sessionStorage.removeItem(key)}}catch{}}
const cacheKey=(bucket,page)=>`exam-prefetch:${bucket}:${page}`;
function cachedExamPage(bucket,page){try{const x=JSON.parse(sessionStorage.getItem(cacheKey(bucket,page))||'null');return x&&Date.now()-x.at<90000?x.value:null}catch{return null}}
function cacheExamPage(bucket,page,value){try{sessionStorage.setItem(cacheKey(bucket,page),JSON.stringify({at:Date.now(),value}))}catch{}}
function cachedExamDetail(id){try{const x=JSON.parse(sessionStorage.getItem('exam-prefetch:detail:'+id)||'null');return x&&Date.now()-x.at<45000?x.value:null}catch{return null}}
function cachedCourse(group){try{const x=JSON.parse(sessionStorage.getItem('exam-prefetch:course:'+group)||'null');return x&&Date.now()-x.at<45000?x.value:null}catch{return null}}
async function loadCourseExams(group){const cached=cachedCourse(group);if(cached)return cached;const response=await fetch('/exam/context?'+new URLSearchParams({group}),{headers:{Accept:'application/json'}});if(!response.ok)throw Object.assign(Error('课程考试暂时无法读取'),{status:response.status});const data=await response.json();if(typeof data.ticket!=='string')throw Error('课程考试信息无效');const result=await api('exam-course-context',{ticket:data.ticket});if(result.group!==group||!Array.isArray(result.records))throw Error('课程考试身份不一致');try{sessionStorage.setItem('exam-prefetch:course:'+group,JSON.stringify({at:Date.now(),value:result.records}))}catch{}return result.records}
let preloadCourses=[],preloadQueue=[],preloadActive=0;const preloadSeen=new Set();
function queuePreloadCourses(){for(const course of preloadCourses){if(!course||typeof course.group!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(course.group)||preloadSeen.has(course.group))continue;if(preloadSeen.size>=12)break;preloadSeen.add(course.group);preloadQueue.push(course.group)}while(preloadActive<2&&preloadQueue.length){const group=preloadQueue.shift();preloadActive++;void loadCourseExams(group).then(async records=>{for(const item of records.slice(0,4)){if(typeof item.id!=='string')continue;try{const value=await api('exam-detail',{id:item.id});sessionStorage.setItem('exam-prefetch:detail:'+item.id,JSON.stringify({at:Date.now(),value}))}catch{}}}).catch(()=>{}).finally(()=>{preloadActive--;queuePreloadCourses()})}}
async function preloadExams(){try{for(const bucket of [0,1]){let page=1,pages=1;do{const value=await api('exams',{page,finished:bucket});cacheExamPage(bucket,page,value);pages=Math.min(bucket===0?3:2,Number(value.pages)||1);page++}while(page<=pages)}}catch{}}
function announcePreloadReady(){let remaining=20;let timer;const send=()=>{if(remaining--<=0){clearInterval(timer);window.removeEventListener('message',ack);return}window.parent.postMessage({type:'exam-preload-ready'},location.origin)};const ack=event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='exam-preload-ack'){preloadCourses=Array.isArray(event.data.courses)?event.data.courses.slice(0,100):[];queuePreloadCourses();clearInterval(timer);window.removeEventListener('message',ack)}};window.addEventListener('message',ack);send();timer=setInterval(send,500)}
function feedback(error){
 const message=String(error?.message||'');
 const first=message.match(/^第一轮(已通过|未通过)(?:，得分\s*([\d.]+))?。/);
 const prefix=first?`第一轮${first[1]}${first[2]?`，得分 ${first[2]}`:''}。`:'';
 if(message.includes('本次未获取到可核对的新答案'))return prefix+'本次未获取到可核对的新答案，已停止再次考试。';
 if(message.includes('本次错题尚未完成核对'))return prefix+'错题库尚未提供可核对的答案，已停止再次考试。';
 if(message.includes('错题未补充可确认答案'))return prefix+'错题未补充可确认答案，已停止再次考试。';
 if(error?.kind==='network')return prefix+'与考试服务的连接中断，平台状态无法确认。请先查看官方平台；不确定时请人工核实，暂勿重复开考或交卷。';
 if(error?.endpoint==='login'&&error?.status===401)return '登录失败，请核对组织代码、账号和官方平台密码。';
 if(error?.status===401||/请先登录|登录已失效/.test(message))return '登录状态已失效，请重新登录后查看考试。';
 if(/考试正在进行|另一场考试正在进行|该考试正在进行/.test(message))return '已有考试正在进行，请回到原考试会话查看，暂勿重复开考。';
 if(/操作较频繁|请求过于频繁/.test(message))return '操作太频繁，请稍后再试；考试状态未确认前不要重复提交。';
 if(/剩余考试次数不足/.test(message))return '平台显示没有剩余考试机会，自动考试未开始。';
 if(/当前不在考试时间内|考试时间无法确认|统一考试时间未返回/.test(message))return '平台未确认当前处于可考试时间，自动考试已停止；请到官方平台核实考试时间。';
 if(/考试需要官方人脸验证|人脸验证策略/.test(message))return '平台要求人脸验证，或未返回相关要求；网站无法确认可继续考试，请使用官方平台核实。';
 if(/身份|报名|会话|考项|历史记录|唯一确认/.test(message))return '考试或会话信息无法与平台记录对应，暂时不能判断结果。请到官方平台核实；必要时由你手动处理。';
 if(/业务繁忙|结果尚未确认|未确认|无法确认|未返回成绩|待核对|未核验|回执|评分|超时|连接|网络|响应|HTTP|解析|请求失败|fetch|network/i.test(message)||error?.kind==='response')return prefix+'平台暂未给出明确结果。请刷新历史成绩核对；确认前不要重复开考或交卷。';
 if(/账号和密码|组织代码/.test(message))return '请填写组织代码、账号和官方平台密码。';
 if(/平台登录失败/.test(message))return '平台未确认登录成功，请核对账号和密码后重试。';
 return prefix+'收到无法识别的考试反馈，暂时无法判断。请先到官方平台核实；仍不确定时请你手动处理。';
}
function progressFeedback(job){
 if(job?.running){
  const message=String(job.message||'');
  if(/第二轮/.test(message))return '第一轮未通过，正在准备下一轮…';
  if(/交卷|提交答卷|匹配/.test(message))return '正在提交答卷并核对成绩…';
  if(/成绩|评分|核对|核验/.test(message))return '正在核对平台成绩…';
  if(/历史答案/.test(message))return '正在核对可用的历史答案…';
  return '自动考试正在处理，请勿重复操作…';
 }
 if(job?.result){
  const result=job.result,state=({PASS:'考试通过',FAIL:'考试未通过',NOT_SCORE:'成绩待核实',SCORING:'平台评分中'})[result.status]||'结果待核实';
  return state+(result.answerScore==null?'':'，得分 '+result.answerScore);
 }
 return feedback(new Error(String(job?.message||'')));
}
async function api(path,data={}) {
 let r;
 try{r=await fetch('./api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})}
 catch{throw Object.assign(new Error('连接中断'),{kind:'network'})}
 let x;
 try{x=await r.json()}catch{throw Object.assign(new Error('服务响应无法识别'),{kind:'response',status:r.status})}
 if(!r.ok){const error=new Error(x.error||'请求失败');error.phase=x.phase;error.elapsedMs=x.elapsedMs;error.status=r.status;error.code=x.code;error.endpoint=path;throw error}
 return x;
}
function status(s){$('#status').textContent=s;$('#workspace-status').textContent=s;$('#detail-status').textContent=s}
function examStatus(item){
 const value=String(item.status||item.attendanceStatus||'').toUpperCase();
 return ({PROGRESS:'进行中',PASS:'已通过',FAIL:'未通过',SCORING:'评分中',NOT_SCORE:'待评分',FINISHED:'待核对',COMPLETED:'待核对',UNKNOWN:'待核对',NOT_STARTED:'未开始'}[value]||'状态待确认');
}
async function load(reset=false){
 if(reset){listVersion++;page=0;pages=1;$('#exams').replaceChildren()}if(page>=pages)return;const version=listVersion;
 const context=$('#course-context');if(context){context.hidden=!courseContext;context.textContent=courseContext?'来自课程「'+courseContext+'」，请核对平台返回的考试名称后再继续。':''}
 status('正在读取考试列表…');
 try{
  const x=await api('exams',{page:page+1,finished,refresh:reset===true});if(version!==listVersion)return;page=Number(x.current)||page+1;pages=Number(x.pages)||1;
  for(const item of x.records){
   const el=document.createElement('article');el.className='exam';
   const name=document.createElement('strong');name.textContent=item.title||item.name||item.resourceName||'未命名考试';
   const detail=document.createElement('span');detail.className='exam-status';detail.textContent=examStatus(item);el.append(name,detail);
   if(typeof item.id==='string'&&typeof item.resourceId==='string'){
    el.classList.add('exam-clickable');el.setAttribute('role','button');el.setAttribute('tabindex','0');el.setAttribute('aria-label','查看'+name.textContent+'详情');
    el.addEventListener('click',()=>showDetail(item.id));el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showDetail(item.id)}});
   }
   $('#exams').append(el);
  }
  if(!$('#exams').children.length&&page<pages)return load();
  if(!$('#exams').children.length)$('#exams').textContent=finished?'暂无已通过考试':'暂无待完成考试';
  $('#more').hidden=page>=pages;status('');
 }catch(e){if(version===listVersion)status(feedback(e))}
}
$('#login').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const button=form.querySelector('[type=submit]');button.disabled=true;status('正在登录…');const data=Object.fromEntries(new FormData(form));try{await api('login',data);form.elements.password.value='';$('#entry').hidden=true;$('#workspace').hidden=false;await load(true)}catch(err){status(feedback(err))}finally{button.disabled=false}});
$('#logout').addEventListener('click',async()=>{try{await api('logout');$('#workspace').hidden=true;$('#entry').hidden=false;$('#exams').replaceChildren();status('已退出登录')}catch(e){status(feedback(e))}});$('#refresh').addEventListener('click',()=>load(true));$('#more').addEventListener('click',()=>load());

async function showDetail(id){status('正在读取考试详情…');try{const {detail}=frameMode?(cachedExamDetail(id)||await api('exam-detail',{id})):await api('exam-detail',{id});$('#detail-title').textContent='考试详情';const body=$('#detail-body');body.dataset.examId=id;body.replaceChildren();for(const [label,value] of [['名称',detail.title],['允许次数',detail.attempt===0?'不限':detail.attempt],['剩余次数',detail.attempt===0?'不限':detail.myAttempt],['题目数量',detail.questionNum],['总分',detail.score],['及格分',detail.passScore],['考试时长（分钟）',detail.time]]){if(value===undefined||value===null||value==='')continue;const row=document.createElement('p');row.textContent=label+'：'+String(value);body.append(row)}const history=document.createElement('details');history.id='history-results';const heading=document.createElement('summary');heading.textContent='历史成绩';const list=document.createElement('div');list.className='history-list';list.textContent='正在读取历史成绩…';history.append(heading,list);body.append(history);if(frameMode&&window.parent!==window)window.parent.postMessage({type:'exam-detail-ready'},location.origin);void refreshHistory(id,history);await showActions(id,body);status('');if(!$('#details').open)$('#details').showModal()}catch(e){status(feedback(e))}}
function closeFrame(){if(frameMode&&window.parent!==window)window.parent.postMessage({type:'exam-frame-close'},location.origin)}
function frameMessage(message,title='考试详情'){$('#detail-title').textContent=title;const body=$('#detail-body');body.dataset.examId='';body.replaceChildren();const p=document.createElement('p');p.textContent=message;body.append(p);$('#detail-status').textContent='';if(!$('#details').open)$('#details').showModal()}
function titleKey(value){return String(value||'').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu,'')}
function titlesMatch(trainingTitle,value){const training=titleKey(trainingTitle),exam=titleKey(value);if(!training||!exam)return false;if(training===exam)return true;if(training.length<6)return false;return exam.includes(training)||(exam.length>=6&&training.includes(exam))}
function titleMatches(value){return titlesMatch(courseContext,value)}
async function findCourseExam(useCache=true){
 if(!courseContext)throw Error('课程名称未提供，请返回课程看板重新进入。');
 for(const bucket of [0,1]){
  let current=1,totalPages=1;const matches=new Map();
  do{
   const result=(useCache&&cachedExamPage(bucket,current))||await api('exams',{page:current,finished:bucket,refresh:current===1&&!useCache});
   const records=Array.isArray(result.records)?result.records:[];
   for(const item of records){const title=item.title||item.name||item.resourceName||'';if(typeof item.id==='string'&&titleMatches(title))matches.set(item.id,item)}
   totalPages=Math.min(10,Math.max(1,Number(result.pages)||1));current++;
  }while(current<=totalPages&&matches.size<5);
  if(matches.size)return [...matches.values()];
 }
 return [];
}
async function openCourseExam(){
 frameMessage('正在匹配课程对应的考试…');
 try{
  let matches=courseGroup?await loadCourseExams(courseGroup):await findCourseExam();
  if(!courseGroup&&!matches.length)matches=await findCourseExam(false);
  if(matches.length===1){await showDetail(matches[0].id);return}
  if(matches.length>1){$('#detail-title').textContent='选择对应考试';const body=$('#detail-body');body.replaceChildren();const note=document.createElement('p');note.textContent='找到多个相符的考试，请核对名称后选择。';body.append(note);for(const item of matches){const button=document.createElement('button');button.type='button';button.className='secondary exam-match-choice';button.textContent=item.title||item.name||item.resourceName||'未命名考试';button.addEventListener('click',()=>showDetail(item.id));body.append(button)}return}
  frameMessage('暂未找到与课程“'+courseContext+'”对应的考试。请返回课程看板刷新，或核对平台中的考试名称。','暂未匹配到考试');
 }catch(error){frameMessage(error?.status===401?'登录状态已失效，请重新登录后查看考试。':'暂时无法读取课程对应的考试，请稍后重试。','暂时无法打开考试')}
}
$('#close-details').addEventListener('click',()=>{closeFrame();$('#details').close()});
$('#details').addEventListener('close',()=>{if(activeTimer!==null){clearInterval(activeTimer);activeTimer=null}});
$('#details').addEventListener('cancel',event=>{if(frameMode){event.preventDefault();closeFrame()}});

function selectExamTab(value){finished=value;$('#list-title').textContent=value?'已完成的考试':'待完成的考试';$('#pending-tab').setAttribute('aria-pressed',String(!value));$('#history-tab').setAttribute('aria-pressed',String(!!value));load(true)}
$('#pending-tab').addEventListener('click',()=>selectExamTab(0));
$('#history-tab').addEventListener('click',()=>selectExamTab(1));
async function refreshHistory(id,group){
 if(!group||!group.isConnected)return;
 const request=Symbol();group.historyRequest=request;const list=group.querySelector('.history-list');
 try{
  const result=await api('exam-history',{id});
  const lines=await Promise.all(result.records.map(async row=>{
  try{const checked=(await api('history-result',{handle:row.handle})).result;const state=({PASS:'通过',FAIL:'未通过',NOT_SCORE:'待评分',SCORING:'评分中'}[checked.attendanceStatus]||checked.attendanceStatus||'状态未返回');return [row.createdAt||'时间未返回',checked.answerScore!=null?'得分：'+checked.answerScore:'得分未返回',state].join(' · ')}catch{return (row.createdAt||'时间未返回')+' · 成绩待核实'}
  }));
  if(group.historyRequest!==request||!group.isConnected)return;
  list.replaceChildren();if(!lines.length){list.textContent='暂无历史记录';return}
  for(const text of lines){const line=document.createElement('p');line.textContent=text;list.append(line)}
 }catch(e){if(group.historyRequest===request&&group.isConnected)list.textContent=feedback(e)}
}

async function showActions(id,body){
 if(activeTimer!==null){clearInterval(activeTimer);activeTimer=null}
 const box=document.createElement('div');box.id='exam-actions';body.append(box);
 try {const {phase,resumable,activeElsewhere,lostSession,remainingSeconds,outcome,autoTwoRound}=await api('exam-state',{id});
 let previousText='';
 if(['pending','accepted','submit-uncertain','submitting'].includes(phase)){
  try{const history=await api('exam-history',{id});const previous=history.records.find(row=>!row.current);if(previous){const {result}=await api('history-result',{handle:previous.handle});if(['PASS','FAIL'].includes(result.attendanceStatus))previousText='最近一条已确认成绩为'+(result.attendanceStatus==='PASS'?'通过':'未通过')+(result.answerScore==null?'':'（'+result.answerScore+'分）')}}catch{}
 }
 const messages={ready:'可开始考试',active:resumable?'考试正在进行，可继续处理。':activeElsewhere?'本场考试仍在另一登录会话中进行，请回到原会话查看，暂不重复开考。':'本站已无法恢复原答题会话，当前结果未确认。请先查看官方平台；仍不确定时请你手动核实。',opening:'平台正在确认开考状态，请稍后刷新查看。', 'open-uncertain':'平台未确认开考是否成功。请先核对考试状态，确认前不要再次开考。',submitting:'答卷正在提交，请勿重复交卷。',accepted:'平台已收到交卷请求，成绩尚未返回；请稍后刷新查看。','submit-uncertain':'平台未确认交卷结果。请先刷新历史成绩，确认前不要重复开考或交卷。',pending:'本次成绩尚未确认。'+(previousText?previousText+'，不代表本次结果。':'')+'请稍后刷新核对；仍不确定时请到官方平台查看。',verified:'成绩已核对'};
 const label=document.createElement('p');label.textContent=messages[phase]||'考试状态待核实。请先到官方平台查看；无法判断时请你手动处理。';box.append(label);
 if(phase==='verified'&&outcome?.status==='PASS'&&frameMode&&courseGroup&&window.parent!==window)window.parent.postMessage({type:'exam-verified-pass',group:courseGroup},location.origin);
 if(phase==='verified'&&outcome){const result=document.createElement('p');const state=({PASS:'通过',FAIL:'未通过',NOT_SCORE:'待评分',SCORING:'评分中'}[outcome.status]||'状态未返回');result.textContent=state+(outcome.answerScore==null?'':' · '+outcome.answerScore+'分')+(outcome.passScore==null?'':' · 及格 '+outcome.passScore+'分');box.append(result)}
 if(phase==='active'&&resumable&&Number.isFinite(remainingSeconds)){const timer=document.createElement('p');box.append(timer);const start=performance.now();const update=()=>{if(!timer.isConnected){clearInterval(tick);return}const left=Math.max(0,remainingSeconds-Math.floor((performance.now()-start)/1000));const hours=Math.floor(left/3600),minutes=Math.floor((left%3600)/60),seconds=left%60;timer.textContent='预计剩余时间：'+[hours,minutes,seconds].map(n=>String(n).padStart(2,'0')).join(':')+'（以平台为准）';if(!left)clearInterval(tick)};const tick=setInterval(update,1000);activeTimer=tick;update()}
 const job=await api('exam-run-status',{id});
 const one=document.createElement('button');one.type='button';one.textContent='一键考试';
 if(autoTwoRound!==true){one.disabled=true;const notice=document.createElement('p');notice.textContent='自动答题更新待启用；当前考试会话保持不变。';box.append(notice)}
 else if(activeElsewhere){one.disabled=true}
 else if(job.running||automationRuns.has(id)){one.disabled=true;if(job.running)void monitorExam(id,body)}
 else one.addEventListener('click',()=>oneClickAnswer(id,body,one,phase,resumable,lostSession));
 box.append(one);

 }catch(e){status(feedback(e))}
}

async function monitorExam(id,body){
 if(automationRuns.has(id))return;
 automationRuns.add(id);
 try{
  for(;;){
   const job=await api('exam-run-status',{id});
   if(body.dataset.examId===id){status(progressFeedback(job));if(job.result)void refreshHistory(id,body.querySelector('#history-results'))}
   if(!job.running)break;
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
 }catch(e){if(body.dataset.examId===id)status(feedback(e))}
 finally{automationRuns.delete(id);if(body.dataset.examId===id){const box=body.querySelector('#exam-actions');if(box)box.remove();await showActions(id,body)}}
}
async function oneClickAnswer(id,body,button,phase,resumable,knownLost){
 if(automationRuns.has(id))return;
 const lostSession=(phase==='active'&&!resumable)||knownLost===true;
 const unresolved=['pending','accepted','submit-uncertain','submitting'].includes(phase);
 const uncertainOpen=phase==='open-uncertain';
 const prompt=uncertainOpen?'请先确认官方 APP 显示待考试且没有进行中的答卷。确认后将保留旧记录并重新开考，可能消耗考试机会。':lostSession?'本网站已失去原答题会话。确认核对平台状态，并在尚无成绩时保留原记录、尝试重新考试？可能额外消耗一次机会。':unresolved?'上次交卷结果尚未确认。确认先核对原考试状态？':'确认自动答题并交卷？答案不足时将留空提交，并可能再考一次。';
 if(!window.confirm(prompt)){status('已取消');return}
 button.disabled=true;
 try{await api('exam-run-start',{id,confirmed:true,recoverLost:lostSession,confirmedPlatformPending:uncertainOpen});void monitorExam(id,body)}catch(e){status(feedback(e));button.disabled=false}
}

$('#toggle-password').addEventListener('click',()=>{const input=$('[name=password]');const visible=input.type==='password';input.type=visible?'text':'password';$('#toggle-password').textContent=visible?'隐藏':'显示';$('#toggle-password').setAttribute('aria-label',visible?'隐藏密码':'显示密码')});

(async()=>{try{await api('session');$('#entry').hidden=true;if(preloadMode){$('#workspace').hidden=true;announcePreloadReady();await new Promise(resolve=>setTimeout(resolve,500));if(!preloadCourses.length)await preloadExams()}else if(frameMode){$('#workspace').hidden=true;await openCourseExam()}else{$('#workspace').hidden=false;await load(true)}}catch(error){if(preloadMode)window.parent.postMessage({type:'exam-preload-failed'},location.origin);else if(frameMode){$('#entry').hidden=true;$('#workspace').hidden=true;if(error?.status===401&&window.parent!==window){frameMessage('正在重新连接考试服务…');window.parent.postMessage({type:'exam-session-expired'},location.origin);setTimeout(()=>frameMessage('考试登录已失效，请关闭后重新打开。','暂时无法打开考试'),2000)}else frameMessage(feedback(error),'暂时无法打开考试')}}})();
