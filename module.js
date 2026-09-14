"use strict";
const support=require("./module-support");
function create(options){
  options=options||{};const s=options.support||support.create("agreement-controls");
  const call=args=>{const result=s.run("unknown-home-account-terms-guard.js",args);if(args[0]!=="status"&&result.launchPolicy&&result.launchPolicy.errorText)throw Error(result.launchPolicy.errorText);return result;};
  function report(){const r=call(["status"]);r.healthy=(!r.enabled||r.running)&&!(r.launchPolicy&&r.launchPolicy.errorText);r.changesAcceptanceState=false;r.warning="Local prompt and launch-metadata controls only. This neither accepts nor withdraws consent, and does not authenticate to LG.";return r;}
  async function run(action,args){
    args=args||{};
    if(action==="enable"){s.claim();const old=s.state();if(!old)s.save({desired:call(["status"]).enabled});else call([old.desired?"on":"off"]);call(["restart-enabled"]);s.run("unknown-home-eula-launch-policy.js",["install-runtime-unit"]);s.save({desired:call(["status"]).enabled,suspended:false});}
    else if(action==="disable"){s.claim();s.suspend(call(["status"]).enabled);call(["off"]);s.run("unknown-home-eula-launch-policy.js",["remove-runtime-unit"]);}
    else if(action==="reconcile"||action==="maintenance"){s.claim();call(["start-enabled"]);if(action==="reconcile")s.run("unknown-home-eula-launch-policy.js",["install-runtime-unit"]);}
    else if(action==="setPrompts"){if(typeof args.enabled!=="boolean")throw Error("Expected enabled boolean");call([args.enabled?"on":"off"]);s.save({desired:args.enabled});}
    else if(action==="viewLog")return {log:(options.log||(()=>{const fs=require("fs"),p="/tmp/unknown-home-account-terms-guard.log";try{const fd=fs.openSync(p,"r"),stat=fs.fstatSync(fd),b=Buffer.alloc(Math.min(16384,stat.size));try{fs.readSync(fd,b,0,b.length,Math.max(0,stat.size-b.length));return b.toString();}finally{fs.closeSync(fd);}}catch(e){if(e.code==="ENOENT")return "No events recorded";throw e;}}))()};
    else if(!["status","health"].includes(action))throw Error("Unknown agreement action");
    return report();
  }
  return {run};
}
if(require.main===module)support.main(create);module.exports={create};
