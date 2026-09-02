package com.termux.paseo;

/**
 * 把 EAC 的「添加工作区」目录选择接到 Android 系统文件管理器(SAF)上。
 *
 * <p>EAC 自带的目录选择有 browse(自制列表对话框)和 native(调 OS 对话框)两个表面,
 * native 表面的 host 端是 Win32 专用(koffi + user32.dll),Android 上只剩 browse ——
 * 层层点目录在手机上很难用,而且默认起点是应用私有 home。这个 shim 在 WebView 里
 * 拦截「添加工作区」入口:
 *
 * <ol>
 *   <li>命中入口时<b>不</b>吞掉点击 —— 原生 trusted 事件自己把「选择工作区目录」
 *       对话框打开,留在 SAF 界面底下;同时调
 *       {@code PaseoAndroid.pickWorkspaceDirectory()}(PaseoActivity 的 SAF 流程,
 *       含共享存储权限补请求)把系统文件管理器盖在最上层。合成事件重放实测会被
 *       前端丢弃,不重放就没有这个坑。</li>
 *   <li>SAF 选完回到页面,轮询等对话框就绪:点「编辑路径」让路径输入框出现
 *       (EAC 前端不用 data-testid,按界面文本匹配,兼容中英文;React 组件优先
 *       直调 __reactProps 的 onClick,绕过 isTrusted 过滤,找不到再退合成事件)。</li>
 *   <li>用 React 的 native value setter 把路径写进输入框,派发 input 事件后回车,
 *       对话框即导航到所选目录;</li>
 *   <li>最后点「打开」完成工作区创建。</li>
 * </ol>
 *
 * <p>任何一步找不到预期节点(前端改版/语言变化),都退化为 toast 提示路径,
 * 用户仍可手动粘贴 —— 只降级,不断路。脚本统一单引号、CSS 属性选择器不带引号,
 * Java 拼接零转义。
 */
final class PaseoWorkspacePickerShim {

    /** 幂等标记;挂在 window 上,重复注入直接返回。 */
    static final String FLAG = "__paseoWorkspacePicker";

    private PaseoWorkspacePickerShim() {
    }

    static String injectionScript() {
        return "(function(){"
            + "var w=window,d=document;"
            + "if(w." + FLAG + ")return;w." + FLAG + "=true;"
            + "var busy=false;"
            + "var ENTRY_TEXTS=['添加工作区','Add workspace','Add Workspace'];"
            + "function toast(msg,isErr){"
            + "var n=d.getElementById('paseo-picker-toast');"
            + "if(!n){n=d.createElement('div');n.id='paseo-picker-toast';"
            + "n.style.cssText='position:fixed;left:16px;right:16px;bottom:96px;z-index:2147483646;"
            + "padding:12px 14px;border-radius:8px;background:#202624;color:#f4f7f6;"
            + "font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)';"
            + "d.body.appendChild(n);}"
            + "n.textContent=msg;"
            + "n.style.border=isErr?'1px solid #d56565':'1px solid #4b8f72';"
            + "n.hidden=false;"
            + "clearTimeout(toast.t);toast.t=setTimeout(function(){n.hidden=true;},4200);}"
            + "function hasBridge(){return !!(w.PaseoAndroid&&typeof w.PaseoAndroid.pickWorkspaceDirectory==='function');}"
            + "function visible(el){return !!(el&&el.offsetParent!==null);}"
            + "function matchEntry(target){"
            // EAC 前端不用 data-testid,按钮也可能不是 button 标签;沿祖先链找
            // textContent 恰为「添加工作区」的元素。
            + "if(!target)return null;"
            + "var cur=target;"
            + "while(cur&&cur!==d.body){"
            + "var t=(cur.textContent||'').trim();"
            + "for(var i=0;i<ENTRY_TEXTS.length;i++)if(t===ENTRY_TEXTS[i])return cur;"
            + "cur=cur.parentElement;}"
            + "return null;}"
            + "function findButtonByText(){"
            // EAC 的「编辑路径」是纯图标按钮,文字在 aria-label/title 里;三个通道都查。
            + "var texts=arguments;"
            + "var bs=d.querySelectorAll('button,[role=button]');"
            + "for(var i=0;i<bs.length;i++){var b=bs[i];"
            + "if(!visible(b))continue;"
            + "var aria=b.getAttribute('aria-label')||b.getAttribute('title')||'';"
            + "var txt=(b.textContent||'').trim();"
            + "for(var j=0;j<texts.length;j++)if(txt===texts[j]||aria===texts[j])return b;}"
            + "return null;}"
            + "function findInput(){"
            + "var inputs=d.querySelectorAll('input[type=text],input:not([type])');"
            + "for(var i=0;i<inputs.length;i++)if(visible(inputs[i]))return inputs[i];"
            + "return null;}"
            + "function reactInput(input,value){"
            + "var proto=input.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;"
            + "Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);"
            + "input.dispatchEvent(new Event('input',{bubbles:true}));}"
            + "function pressEnter(input){"
            + "['keydown','keypress','keyup'].forEach(function(type){"
            + "input.dispatchEvent(new KeyboardEvent(type,"
            + "{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));});}"
            + "function waitUntil(cond,timeoutMs,done){"
            + "var start=Date.now();"
            + "(function poll(){var v=cond();"
            + "if(v){done(v);return;}"
            + "if(Date.now()-start>timeoutMs){done(null);return;}"
            + "setTimeout(poll,250);})();}"
            // 前端丢弃合成事件(isTrusted=false),React 组件则直调 __reactProps 的
            // onClick;两条路都试不到才放弃 —— 直调优先,避免双触发。
            + "function callReactClick(el){"
            + "var cur=el;"
            + "while(cur&&cur!==d.body){"
            + "for(var k in cur){"
            + "if(k.indexOf('__reactProps')===0&&cur[k]&&typeof cur[k].onClick==='function'){"
            + "try{cur[k].onClick({preventDefault:function(){},stopPropagation:function(){},"
            + "stopImmediatePropagation:function(){},target:el,currentTarget:cur,"
            + "nativeEvent:new MouseEvent('click',{bubbles:true})});return true;}catch(err){}"
            + "}}"
            + "cur=cur.parentElement;}"
            + "return false;}"
            + "function syntheticTap(el){"
            + "var r=el.getBoundingClientRect();"
            + "var x=r.left+r.width/2,y=r.top+r.height/2;"
            + "var opts={bubbles:true,cancelable:true,clientX:x,clientY:y,view:window};"
            + "try{"
            + "el.dispatchEvent(new PointerEvent('pointerdown',"
            + "Object.assign({pointerId:1,pointerType:'touch',isPrimary:true},opts)));"
            + "el.dispatchEvent(new MouseEvent('mousedown',opts));"
            + "el.dispatchEvent(new PointerEvent('pointerup',"
            + "Object.assign({pointerId:1,pointerType:'touch',isPrimary:true},opts)));"
            + "el.dispatchEvent(new MouseEvent('mouseup',opts));"
            + "}catch(err){}"
            + "el.dispatchEvent(new MouseEvent('click',opts));}"
            + "function tapElement(el){"
            + "var viaReact=callReactClick(el);"
            + "console.log('paseo-picker-tap react='+viaReact);"
            + "if(!viaReact)syntheticTap(el);}"
            + "d.addEventListener('click',function(e){"
            + "var t=matchEntry(e.target);"
            + "if(!t||busy||!hasBridge())return;"
            // 不 preventDefault:原生 trusted 点击自己打开目录对话框,叠在 SAF 底下;
            // SAF 关闭后对话框已就绪,只需填路径。
            + "busy=true;"
            + "console.log('paseo-picker-intercept entry');"
            + "w.PaseoAndroid.pickWorkspaceDirectory();"
            + "},true);"
            + "w.addEventListener('paseo:directory-picked',function(e){"
            + "var detail=e&&e.detail||{};"
            + "busy=false;"
            + "if(detail.error){toast(detail.error,true);return;}"
            + "if(detail.cancelled||!detail.path)return;"
            + "var path=detail.path;"
            + "waitUntil(function(){"
            + "var inp=findInput();"
            + "if(inp)return inp;"
            // 对话框初始是目录列表,先点「编辑路径」让路径输入框出现。
            + "var edit=findButtonByText('编辑路径','Edit path','Edit Path');"
            + "if(edit)tapElement(edit);"
            + "return null;"
            + "},10000,function(input){"
            + "if(!input){"
            + "console.log('paseo-picker-wait-timeout');"
            // 超时诊断:对话框可能是 shadow DOM 或文本节点被拆分,把真实结构打出来校准。
            + "var dlg=d.querySelector('[role=dialog],[aria-modal=true]');"
            + "console.log('paseo-picker-debug dialog='+(dlg?'YES':'NO')+' shadow='+(!!(d.body.shadowRoot)));"
            + "if(dlg)console.log('paseo-picker-debug-html '+dlg.outerHTML.slice(0,900).replace(/\\s+/g,' '));"
            + "toast('请手动粘贴路径: '+path,false);return;}"
            + "console.log('paseo-picker-fill path');"
            + "reactInput(input,path);"
            + "setTimeout(function(){"
            + "pressEnter(input);"
            + "setTimeout(function(){"
            + "var btn=findButtonByText('打开','Open','选择','Choose');"
            + "if(btn){console.log('paseo-picker-open');tapElement(btn);}"
            + "},700);"
            + "},150);"
            + "});"
            + "});"
            // 自报注入状态,经 onConsoleMessage 进 logcat,便于诊断。
            + "console.log('paseo-workspace-picker-shim-ready bridge='+hasBridge());"
            + "})();";
    }
}
