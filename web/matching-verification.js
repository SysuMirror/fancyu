document.addEventListener('DOMContentLoaded',async()=>{
 const token=localStorage.getItem('token');if(!token)return;
 const box=document.createElement('aside');box.style.cssText='background:#edf3e5;color:#15563d;padding:14px 20px;margin:16px auto;max-width:850px;border:1px solid #ccdcbc;border-radius:12px;font:14px/1.7 system-ui;';
 try{const r=await fetch('/api/account/student-verification',{headers:{Authorization:'Bearer '+token}}),d=await r.json();if(d.code!==200)throw Error();
 if(d.verified){box.textContent='✓ 学生邮箱已验证，可在个人中心主动开启每周配对或每周交友。';}
 else{box.append(document.createTextNode('所有配对都需先验证学生邮箱。你可以先填写和保存问卷，验证后再开启配对。 '));const a=document.createElement('a');a.href='/verify-student';a.textContent='去验证学生邮箱 →';a.style.color='#15563d';box.append(a);}
 }catch(e){box.textContent='暂时无法确认学生邮箱验证状态，请刷新重试。未验证前不能开启配对。';}
 (document.querySelector('main')||document.body).prepend(box);
});
