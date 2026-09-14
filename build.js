"use strict";
const fs=require("fs"),path=require("path"),cp=require("child_process"),yazl=require("yazl"),acorn=require("acorn");
const archive=require("./module-archive"),root=__dirname,config=require("./build-config.json");
function read(relative){archive.safePath(relative);const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!fs.lstatSync(file).isFile())throw Error("Invalid build input: "+relative);return fs.readFileSync(file);}
function source(){return config.inputs.map(item=>({name:item.target,bytes:read(item.source)}));}
function check(){
  if(Number(process.versions.node.split(".")[0])<20)throw Error("Node.js 20+ required");
  for(const file of config.sourceFiles){if(file.endsWith(".js"))acorn.parse(read(file).toString("utf8"),{ecmaVersion:2022});}
  const files=source(),manifest=JSON.parse(files.find(item=>item.name==="module.json").bytes);
  manifest.files=Object.fromEntries(files.filter(item=>item.name!=="module.json").map(item=>[item.name,archive.digest(item.bytes)]));
  if(config.home)manifest.files["unknown-home.ipk"]="0".repeat(64);
  archive.validateManifest(manifest,config.coreVersion);
  if(manifest.id!==config.id||manifest.version!==config.version)throw Error("Release identity differs from build configuration");
  if(config.home){const app=JSON.parse(read("app/appinfo.json"));if(app.version!==config.version||app.id!=="org.unknown.home.module")throw Error("Unexpected Home app identity");}
  console.log("Local source syntax, manifest and build inputs verified; no TV contacted.");return files;
}
async function zip(files){return new Promise((resolve,reject)=>{
  const output=new yazl.ZipFile(),chunks=[];output.outputStream.on("data",chunk=>chunks.push(chunk));output.outputStream.on("error",reject);output.outputStream.on("end",()=>resolve(Buffer.concat(chunks)));
  for(const file of files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0))output.addBuffer(file.bytes,file.name,{mtime:new Date("2020-01-01T00:00:00Z"),mode:0o100644});output.end();
});}
async function build(){
  const files=check(),dist=path.join(root,"dist");fs.mkdirSync(dist,{recursive:true});let stage;
  try{
    if(config.home){
      stage=fs.mkdtempSync(path.join(dist,"home-"));
      const cli=require.resolve("@webos-tools/cli/bin/ares-package.js");
      const result=cp.spawnSync(process.execPath,[cli,"--no-minify","-o",stage,path.join(root,"app"),path.join(root,"service")],{stdio:"inherit",timeout:120000});
      if(result.error||result.status!==0)throw Error("Home IPK packaging failed");
      const packages=fs.readdirSync(stage).filter(file=>file.endsWith(".ipk"));if(packages.length!==1)throw Error("Expected one Home IPK");
      files.push({name:"unknown-home.ipk",bytes:fs.readFileSync(path.join(stage,packages[0]))});
    }
    const manifest=JSON.parse(files.find(item=>item.name==="module.json").bytes),payload=files.filter(item=>item.name!=="module.json");
    manifest.files=Object.fromEntries(payload.map(item=>[item.name,archive.digest(item.bytes)]));
    const bytes=await zip(payload.concat([{name:"module.json",bytes:Buffer.from(JSON.stringify(manifest,null,2)+"\n")}]));
    const result=await archive.inspectArchive(bytes,config.coreVersion),name=config.id+"-"+config.version+".zip";
    fs.writeFileSync(path.join(dist,name),bytes);fs.writeFileSync(path.join(dist,"SHA256SUMS.txt"),result.sha256+"  "+name+"\n");console.log("Validated module ZIP: dist/"+name);
  }finally{
    if(stage){const full=path.resolve(stage);if(!full.startsWith(dist+path.sep)||!path.basename(full).startsWith("home-"))throw Error("Invalid cleanup boundary");fs.rmSync(full,{recursive:true,force:true});}
  }
}
if(require.main===module)(process.argv.includes("--check")?Promise.resolve().then(check):build()).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={build,check};
