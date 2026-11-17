(() => {
    /* 深色模式默认关闭。只有个人中心明确打开后才变暗，不跟随系统。 */
    const themeSaved=(()=>{try{return localStorage.getItem('fancyu-theme')||'';}catch(e){return '';}})();
    const themeDark=themeSaved==='dark';
    document.documentElement.dataset.theme=themeDark?'dark':'light';
    document.documentElement.style.colorScheme=themeDark?'dark':'light';
    const loadDarkCss=()=>{
        if(document.getElementById('fancyuDarkCss'))return;
        const l=document.createElement('link');
        l.id='fancyuDarkCss';l.rel='stylesheet';l.href='/dark.css?v=20261116b';
        document.head.appendChild(l);
    };
    if(themeDark)loadDarkCss();
    // 页面上的「深色模式」开关调这两个
    window.fancyuTheme=()=>document.documentElement.dataset.theme==='dark';
    window.fancyuSetTheme=dark=>{
        try{localStorage.setItem('fancyu-theme',dark?'dark':'light');}catch(e){}
        document.documentElement.dataset.theme=dark?'dark':'light';
        document.documentElement.style.colorScheme=dark?'dark':'light';
        if(dark)loadDarkCss();
        document.dispatchEvent(new CustomEvent('fancyu:theme',{detail:{dark:!!dark}}));
    };
    const token=localStorage.getItem('token');
    if(token) {try {const p=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(p.security_version!==2||p.exp*1000<Date.now())throw Error();}
        catch(e){localStorage.removeItem('token');localStorage.removeItem('user');}}
    // 站内已知 clean URL 一级页（登录/注册后允许回跳的白名单）
    const KNOWN_PAGES=['/','/index','/login','/register','/forgot-password','/weekly-match','/deep','/friends','/chat','/notifications','/survey','/friend_survey','/profile','/verify-student','/pay'];
    // 登录/注册回跳校验器：只接受白名单内的一级 clean URL（保留 query），其余回首页。
    // 防开放重定向：必须以单个 '/' 开头，字符集受限，拒绝 '//evil.com'、'/\evil.com'。
    window.fancyuSafeRedirect=function(raw){
        try{
            const s=String(raw==null?'':raw).trim();
            if(!s)return '/';
            if(s.charAt(0)!=='/')return '/';
            if(s.charAt(1)==='/'||s.charAt(1)==='\\')return '/';
            if(!/^\/[A-Za-z0-9_\-/?=&%.#]*$/.test(s))return '/';
            const pathPart=s.split('?')[0].split('#')[0].replace(/\.html$/i,'');
            const norm=pathPart===''?'/':pathPart.replace(/\/+$/,'')||'/';
            return KNOWN_PAGES.includes(norm==='/index'?'/':norm)?s:'/';
        }catch(e){return '/';}
    };
    // 当前页路径（含 query），用于 401 后把用户送回原处
    window.fancyuCurrentPath=function(){return location.pathname+location.search;};
    const original=window.fetch.bind(window);
    window.fetch=async(...args)=>{
        const response=await original(...args);
        const url=String(args[0]);
        if(response.status===401 && (url.startsWith('/api/account/')||url.startsWith('/api/daily/'))&&!url.endsWith('/login')) {
            localStorage.removeItem('token');localStorage.removeItem('user');
            location.replace('/login?redirect='+encodeURIComponent(window.fancyuCurrentPath()));
        }
        return response;
    };
})();

(()=>{const s=document.createElement('script');s.src='/school-email.js?v=2';document.head.appendChild(s);})();
