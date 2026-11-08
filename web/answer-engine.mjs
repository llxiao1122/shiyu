const text = x => typeof x === 'string' ? x.trim() : '';
const stringId = x => typeof x === 'string' && x.length > 0;
const key = q => `${q.id}\u0000${q.type || q.questionType}`;
const normalized = value => typeof value==='string'?value.normalize('NFKC').replace(/\s+/g,' ').trim():'';
const stem = q => {const value=q?.content||q?.questionContent||'';return typeof value==='string'?normalized(value.replace(/<br\s*\/?\s*>/gi,' ').replace(/<\/?(?:p|div|span|strong|b|em|i|u|font)(?:\s[^>]*)?>/gi,'').replace(/&nbsp;|&#160;|&#x0*a0;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")):''};
const hasImage = x => !!(x?.imageInd||x?.imageUrl||x?.image||/<(?:img|svg|video|audio|object|iframe)\b/i.test(x?.content||x?.questionContent||''));
function byContent(current,source){
 const left=current?.questionOptionList,right=source?.questionOptionList;
 if(!stem(current)||stem(current)!==stem(source)||hasImage(current)||hasImage(source)||!validOptions(left)||!validOptions(right)||left.length!==right.length||left.some(hasImage)||right.some(hasImage))return null;
 const a=left.map(o=>normalized(o.content)),b=right.map(o=>normalized(o.content));
 if(a.some(x=>!x)||b.some(x=>!x)||new Set(a).size!==a.length||new Set(b).size!==b.length||a.some(x=>!b.includes(x)))return null;
 return new Map(right.map((option,index)=>[option.id,left[a.indexOf(b[index])].id]));
}
function validOptions(options) {
 return Array.isArray(options) && options.length>0 && options.every(o=>stringId(o.id)) && new Set(options.map(o=>o.id)).size===options.length;
}
function choiceAnswer(source) {
 const options=source?.questionOptionList;if(!validOptions(options)) return {ids:null,conflict:false};
 const flags=options.every(o=>typeof o.correctInd==='boolean')?options.filter(o=>o.correctInd).map(o=>o.id):null;
 let indexed=null;
 if(Array.isArray(source.optionAnswer)&&source.optionAnswer.length>0&&source.optionAnswer.every(Number.isInteger)&&new Set(source.optionAnswer).size===source.optionAnswer.length&&options.every(o=>Number.isInteger(o.index))&&new Set(options.map(o=>o.index)).size===options.length){
  const selected=source.optionAnswer.map(index=>options.find(o=>o.index===index)?.id);
  if(selected.every(Boolean)) indexed=selected;
 }
 if(flags&&indexed){const sort=x=>[...x].sort();if(JSON.stringify(sort(flags))!==JSON.stringify(sort(indexed))) return {ids:null,conflict:true};}
 return {ids:flags?.length?flags:indexed,conflict:false};
}
function buildRecord(q, source) {
 const type=q.type, options=q.questionOptionList, sourceOptions=source.questionOptionList;
 if(!stringId(q.id)||!Number.isInteger(q.index)) return null;
 if(stem(q)&&stem(source)&&stem(q)!==stem(source)) return null;
 if(['S','M','C'].includes(type)) {
  if(!validOptions(options)||!validOptions(sourceOptions)) return null;
  const sameIds=options.length===sourceOptions.length&&options.every(o=>sourceOptions.some(s=>s.id===o.id));
  const mapping=sameIds?null:byContent(q,source);
  if(!sameIds&&!mapping) return null;
  const {ids:selected,conflict}=choiceAnswer(source);
  if(conflict||!selected) return null;
  if(!selected.length||(type==='S'&&selected.length!==1)) return null;
  return {questionId:q.id,type,index:q.index,optionRecords:selected.map(optionId=>({optionId:mapping?mapping.get(optionId):optionId}))};
 }
 if(['T','A'].includes(type)) {
  const answer=text(source.questionAnswer);return answer?{questionId:q.id,type,index:q.index,answer}:null;
 }
 if(type==='F') {
  if(!validOptions(options)||!validOptions(sourceOptions)||options.length!==sourceOptions.length) return null;
  const records=options.map(o=>{const match=sourceOptions.find(s=>s.id===o.id);return match&&text(match.content)?{optionId:o.id,answer:text(match.content)}:null});
  return records.every(Boolean)?{questionId:q.id,type,index:q.index,optionRecords:records}:null;
 }
 return null;
}
const signature=record=>JSON.stringify({...record,...(record.optionRecords?{optionRecords:[...record.optionRecords].sort((a,b)=>a.optionId.localeCompare(b.optionId))}:{})});
function uniqueRecord(q,candidates) {
 if(!candidates.length) return null;
 const records=candidates.map(source=>buildRecord(q,source));
 if(records.some(record=>!record)) return null;
 return records.every(record=>signature(record)===signature(records[0]))?records[0]:null;
}
/** Sources must already be bound to the same resource/account by the caller. */
export function resolvePaper(questions, review=[],wrongBank=[]) {
 if(!Array.isArray(questions)||!questions.length||!Array.isArray(review)||!Array.isArray(wrongBank)) return {complete:false,total:0,matched:0,records:[]};
 const ids=questions.map(q=>q.id);if(ids.some(id=>!stringId(id))||new Set(ids).size!==ids.length) return {complete:false,total:questions.length,matched:0,records:[]};
 const records=[],partial=[],issues=[];let direct=0,fromReview=0,fromBank=0,canSubmitPartial=true;
 for(const q of questions) {
  // Open-paper blank option content is learner state, never a canonical key.
  const directConflict=['S','M','C'].includes(q.type)&&choiceAnswer(q).conflict;
  let record=q.type==='F'?null:buildRecord(q,q),reason=directConflict?'接口答案字段冲突':'缺少可确认答案';
  if(record) direct++;
  else if(!directConflict) {
   const findCandidates=rows=>{
    const exact=rows.filter(r=>key(r)===key(q));if(exact.length)return exact;
    const prompt=stem(q);if(!prompt||hasImage(q)||questions.filter(x=>x.type===q.type&&stem(x)===prompt).length!==1)return [];
    return rows.filter(r=>(r.type||r.questionType)===q.type&&stem(r)===prompt&&!hasImage(r));
   };
   const bankMatches=findCandidates(wrongBank);
   const reviewMatches=findCandidates(review);
   if(bankMatches.length){
    const bankRecord=uniqueRecord(q,bankMatches);
    const reviewRecord=reviewMatches.length?uniqueRecord(q,reviewMatches):null;
    if(bankRecord&&(!reviewMatches.length||(reviewRecord&&signature(bankRecord)===signature(reviewRecord)))){record=bankRecord;fromBank++;}
    else reason='错题库与复核答案冲突或不完整';
   } else if(reviewMatches.length){record=uniqueRecord(q,reviewMatches);if(record)fromReview++;else reason='历史复核答案冲突或不完整';}
  }
  issues.push(record?null:reason);
  if(record) records.push(record);
  if(record) partial.push(record);
  else if(stringId(q.id)&&Number.isInteger(q.index)&&['S','M','C','T','A','F'].includes(q.type)) partial.push({questionId:q.id,type:q.type,index:q.index});
  else canSubmitPartial=false;
 }
 const complete=records.length===questions.length;
 return {complete,total:questions.length,matched:records.length,direct,fromBank,fromReview,issues,records:complete?records:[],partialRecords:canSubmitPartial?partial:null};
}
export function diagnosePaper(questions,sources){
 const summary={total:questions.length,idMatches:0,stemMatches:0,optionContentMappings:0,questionFields:[],sourceFields:[],typeCounts:{}};
 for(const q of questions){
  const type=q.type;summary.typeCounts[type]=(summary.typeCounts[type]||0)+1;
  for(const field of Object.keys(q)) if(!summary.questionFields.includes(field))summary.questionFields.push(field);
  const typed=sources.filter(r=>(r.type||r.questionType)===type);
  if(typed.some(r=>r.id===q.id))summary.idMatches++;
  const candidates=stem(q)?typed.filter(r=>stem(r)===stem(q)):[];
  if(candidates.length)summary.stemMatches++;
  if(candidates.some(r=>byContent(q,r)))summary.optionContentMappings++;
 }
 for(const q of sources)for(const field of Object.keys(q))if(!summary.sourceFields.includes(field))summary.sourceFields.push(field);
 return summary;
}
