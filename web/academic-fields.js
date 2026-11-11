(function(root){
 const groups={'文学':'人文社科类','历史学':'人文社科类','哲学':'人文社科类','理学':'理学类','工学':'工学类','医学':'医学类','经济学':'经济管理类','管理学':'经济管理类','法学':'人文社科类','教育学':'人文社科类','艺术学':'艺术体育类','农学':'其他','其他':'其他'};
 const categories=Object.keys(groups);
 function unpack(value){
  const text=String(value||'').trim(),split=text.indexOf(' · '),category=text.slice(0,split);
  return split>0&&categories.includes(category)?{major_category:category,major_detail:text.slice(split+3)}:{major_detail:text};
 }
 const academic={school:'中山大学',groups,categories,unpack};
 if(typeof module==='object'&&module.exports)module.exports=academic;else root.AcademicFields=academic;
})(globalThis);
