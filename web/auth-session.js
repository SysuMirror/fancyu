(() => {
    const token=localStorage.getItem('token');
    if(token) {try {const p=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(p.security_version!==2||p.exp*1000<Date.now())throw Error();}
        catch(e){localStorage.removeItem('token');localStorage.removeItem('user');}}
    const original=window.fetch.bind(window);
    window.fetch=async(...args)=>{
        const response=await original(...args);
        const url=String(args[0]);
        if(response.status===401 && (url.startsWith('/api/account/')||url.startsWith('/api/daily/'))&&!url.endsWith('/login')) {
            localStorage.removeItem('token');localStorage.removeItem('user');
            location.replace('login.html?redirect='+encodeURIComponent(location.pathname.split('/').pop()||'index.html'));
        }
        return response;
    };
})();

(()=>{const s=document.createElement('script');s.src='/school-email.js?v=2';document.head.appendChild(s);})();
