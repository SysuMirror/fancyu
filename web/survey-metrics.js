/* Collect only a first interaction, never answer values, contact information or tokens in payloads. */
window.createSurveyMetrics=function(mode,getToken){
 let done=false,pending=null,last=0;
 const stepKey='surveySteps:'+mode,stepSent=(()=>{try{return new Set(JSON.parse(sessionStorage.getItem(stepKey)||'[]'));}catch(e){return new Set();}})();
 async function start(){
  if(done)return true;if(pending)return pending;
  const token=getToken();if(!token)return false;
  if(Date.now()-last<3000)return false;last=Date.now();
  pending=(async()=>{try{const response=await fetch('/api/account/metrics/survey-start',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({mode}),signal:AbortSignal.timeout(2500)});done=response.ok;return done;}catch{return false;}finally{pending=null;}})();
  return pending;
 }
 // Per-section drop-off funnel: report the first entry into each section (0-4), once per browser session.
 // The payload only ever contains identifiers and counters, never answer values.
 async function reportStep(step){
  step=Number(step);
  if(!Number.isInteger(step)||step<0||step>4)return false;
  if(stepSent.has(step))return true;
  const token=getToken();if(!token)return false;
  stepSent.add(step);try{sessionStorage.setItem(stepKey,JSON.stringify([...stepSent]));}catch(e){}
  try{const response=await fetch('/api/account/metrics/survey-start',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({mode,step}),signal:AbortSignal.timeout(2500)});return response.ok;}catch(e){return false;}
 }
 return {start,reportStep};
};
