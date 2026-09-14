"use strict";
const fs=require("fs"),path=require("path"),cp=require("child_process");
function create(id,options){
  options=options||{};
  const data=options.data||process.env.UNKNOWN_MODULE_DATA,base=options.base||"/var/lib/unknown-home",payload=options.payload||path.join(__dirname,"runtime");
  if(!data||!path.isAbsolute(data))throw Error("Private module data directory required");
  function directory(folder){fs.mkdirSync(folder,{recursive:true,mode:0o700});const s=fs.lstatSync(folder);if(!s.isDirectory()||s.isSymbolicLink()||(!options.testing&&(s.uid!==0||(s.mode&0o022))))throw Error("Unsafe module directory");}
  function read(file,fallback){try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>2097152)throw Error("Unsafe or oversized state file");return JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){if(e.code==="ENOENT")return fallback;throw e;}}
  function write(file,value){directory(path.dirname(file));const text=JSON.stringify(value,null,2)+"\n";if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink())throw Error("Refusing linked state file");if(fs.readFileSync(file,"utf8")===text)return;}const tmp=file+".tmp-"+process.pid;fs.writeFileSync(tmp,text,{flag:"wx",mode:0o600});fs.renameSync(tmp,file);}
  function state(){const s=read(path.join(data,"settings.json"),null);if(s&&s.version!==1)throw Error("Unknown module settings version");return s;}
  function save(value){write(path.join(data,"settings.json"),Object.assign({version:1},value));}
  function suspend(desired){const prior=state();if(!prior||!prior.suspended)save({desired,suspended:true});}
  function claim(){const guardian=path.join(base,"unknown-home-guardian.sh");if(fs.existsSync(guardian)&&!fs.readFileSync(guardian,"utf8").includes("UNKNOWN_CORE_OWNERS_V1"))throw Error("Legacy guardian requires an explicit ownership-aware migration before enabling this module");write(path.join(base,"core-owners",id+".json"),{module:id,version:1});}
  function run(name,args){
    if(!/^unknown-home-[a-z-]+\.js$/.test(name))throw Error("Unknown runtime name");
    const r=(options.execute||cp.spawnSync)(process.execPath,[path.join(payload,name)].concat(args||[]),{encoding:"utf8",timeout:45000,maxBuffer:256*1024,env:Object.assign({},process.env,{UNKNOWN_HOME_EULA_POLICY_NO_SAM_RESTART:"1"})});
    if(r.error||r.status!==0)throw Error(String(r.stderr||r.error&&r.error.message||"Feature operation failed").slice(-1500));
    const result=JSON.parse(r.stdout||"{}");if(result.returnValue===false)throw Error(result.errorText||"Feature operation failed");return result;
  }
  return {id,data,base,read,write,state,save,suspend,claim,run,exists:fs.existsSync};
}
function main(createModule){if(process.platform!=="linux"||typeof process.getuid!=="function"||process.getuid()!==0){process.stderr.write("Owner-controlled unjailed root TV required\n");process.exitCode=1;return;}Promise.resolve().then(()=>createModule().run(process.argv[2]||"status",JSON.parse(process.argv[3]||"{}"))).then(result=>process.stdout.write(JSON.stringify(Object.assign({returnValue:true},result))+"\n")).catch(e=>{process.stdout.write(JSON.stringify({returnValue:false,errorText:e.message})+"\n");process.exitCode=1;});}
module.exports={create,main};
