/* Collect only a first interaction, never answer values, contact information or tokens in payloads. */
window.createSurveyMetrics=function(mode,getToken){
 let done=false,pending=null,last=0;
 async function start(){
  if(done)return true;if(pending)return pending;
  const token=getToken();if(!token)return false;
  if(Date.now()-last<3000)return false;last=Date.now();
  pending=(async()=>{try{const response=await fetch('/api/account/metrics/survey-start',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({mode}),signal:AbortSignal.timeout(2500)});done=response.ok;return done;}catch{return false;}finally{pending=null;}})();
  return pending;
 }
 return {start};
};
