'use strict';
// Keep the canonical address in the existing field so autofill, validation and submission agree.
(function injectRowStyle(){
  if(document.getElementById('school-email-row-style'))return;
  const st=document.createElement('style');
  st.id='school-email-row-style';
  st.textContent=[
    '.school-email-row{display:flex;align-items:stretch;gap:8px;width:100%}',
    '.school-email-row>input,.school-email-row>select{min-width:0}',
    '.school-email-row>input{flex:1 1 auto;width:auto;margin:0}',
    '.school-email-row>select{flex:0 1 auto;width:auto;max-width:60%;margin:0}',
    '@media (max-width:480px){.school-email-row>select{max-width:50%;font-size:13px}}'
  ].join('');
  document.head.appendChild(st);
})();
function setupSchoolEmailFields() {
  const fields = document.querySelectorAll('input[type=email], #login, #adminUser, #contactValueAdd');
  for (const field of fields) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', '选择邮箱后缀');
    select.style.cssText = 'padding:6px 10px;color:#214b38;background:#fcfdf9;border:1px solid #b7ccb9;border-radius:8px;font:inherit;font-size:14px';
    select.add(new Option('选择邮箱后缀', ''));
    for (const host of ['mail','mail2','mail3']) {
      const suffix = '@' + host + '.sysu.edu.cn';
      select.add(new Option(suffix, suffix));
    }
    // Put the input and the suffix picker on ONE row (inline), never stacked.
    const row = document.createElement('div');
    row.className = 'school-email-row';
    field.parentNode.insertBefore(row, field);
    row.appendChild(field);
    row.appendChild(select);
    if (field.type === 'email') field.placeholder = '填写邮箱前缀，再选择后缀';
    select.addEventListener('change', () => {
      if (!select.value) return;
      const prefix = field.value.trim().split('@')[0];
      field.value = prefix + select.value;
      select.value = '';
      field.dispatchEvent(new Event('input', {bubbles:true}));
      field.dispatchEvent(new Event('change', {bubbles:true}));
      field.focus();
      if (!prefix) {
        // Text inputs support caret positioning. Email fields do not.
        const type=field.type;
        if(type==='email') field.type='text';
        field.setSelectionRange(0,0);
        if(type==='email') field.addEventListener('blur',()=>{field.type='email';},{once:true});
      }
    });
    if (field.id === 'contactValueAdd') {
      const method=document.getElementById('contactMethodAdd');
      const update=()=>{select.hidden=method.value!=='邮箱';};
      method.addEventListener('change',update); update();
    }
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setupSchoolEmailFields);else setupSchoolEmailFields();
