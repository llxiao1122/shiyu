/** Preserve large integral JSON values before JSON.parse rounds them.
 * Scan quoted strings and escapes without interpreting or rewriting their content.
 */
export function parseLosslessJson(source) {
 if(typeof source!=='string') throw new TypeError('JSON source must be text');
 let safe='',i=0;const numberPattern=/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
 while(i<source.length){
  const ch=source[i];
  if(ch==='"'){
   const start=i++;let closed=false;
   while(i<source.length){const c=source[i++];if(c==='\\'){if(i<source.length)i++;continue}if(c==='"'){closed=true;break}}
   if(!closed) throw new SyntaxError('Unterminated string');
   safe+=source.slice(start,i);continue;
  }
  if(ch==='-'||(ch>='0'&&ch<='9')){
   numberPattern.lastIndex=i;const match=numberPattern.exec(source);
   if(match){const token=match[0];safe+=/^-?\d{16,}$/.test(token)?`"${token}"`:token;i+=token.length;continue}
  }
  safe+=ch;i++;
 }
 return JSON.parse(safe,(key,value)=>{
  if(typeof value==='number'&&(/^(id|ID)$/.test(key)||/(?:Id|ID|_id)$/.test(key))){
   if(!Number.isSafeInteger(value)) throw new SyntaxError('Invalid numeric identifier');
   return String(value);
  }
  return value;
 });
}
