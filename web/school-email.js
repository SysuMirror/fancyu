'use strict';
// Keep the canonical address in the existing field so autofill, validation and submission agree.
function setupSchoolEmailFields() {
  const fields = document.querySelectorAll('input[type=email], #login, #adminUser, #contactValueAdd');
  for (const field of fields) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', '选择邮箱后缀');
    select.style.cssText = 'max-width:100%;width:auto;padding:6px 10px;margin:4px 0;color:#214b38;background:#fcfdf9;border:1px solid #b7ccb9;border-radius:8px;font:inherit;font-size:14px';
    select.add(new Option('选择邮箱后缀', ''));
    for (const host of ['mail','mail2','mail3']) {
      const suffix = '@' + host + '.sysu.edu.cn';
      select.add(new Option(suffix, suffix));
    }
    field.insertAdjacentElement('afterend', select);
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
