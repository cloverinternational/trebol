/** Explicit approved preview publication through canonical SkillManage owner.
 * No direct source writes. --apply required; metadata normalization is store-owned.
 */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {AutoSkillManager} from '../../../packages/context/autogenskills/src/index.ts';
const folder=resolve(process.argv[2]??'');if(!process.argv[2])throw Error('Preview folder required');
const m=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));const source=resolve(m.source);
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
execFileSync('python',['tools/experiments/skill-curation/body_cleanup.py','verify',folder]);
if(sha(readFileSync(source))!==m.source_sha256)throw Error('Live body differs from reviewed source');
const preview=readFileSync(join(folder,'SKILL.preview.md'),'utf8');
const match=preview.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);if(!match)throw Error('Invalid preview frontmatter');
const name=source.split('/').at(-2)!;const root=resolve(source,'../..');
if(source!==join(root,name,'SKILL.md'))throw Error('Unexpected source path');
const manager=new AutoSkillManager({mode:'manual',dir:root,requireReadBeforeWrite:true});
let viewed=manager.execute({action:'view',name,limit:1});let revision=viewed.revision;
const receipt:any={name,source,sourceSha256:m.source_sha256,initialRevision:revision,writes:[],applied:false};
const receiptPath=join(folder,'publication-receipt.json');if(existsSync(receiptPath))throw Error('Receipt exists; inspect before retry');
for(const s of m.segments){
 const rel=s.reference;if(!/^references\/curation-history\/[a-f0-9]+\.md$/.test(rel))throw Error('Unsafe support path');
 if(existsSync(join(root,name,rel)))throw Error('Support path already exists; inspect before overwrite');
 if(sha(readFileSync(join(folder,rel)))!==s.section_sha256)throw Error('Preserved bytes changed');
}
if(!process.argv.includes('--apply')){console.log(JSON.stringify({dryRun:true,name,revision,sections:m.segments.length}));process.exit(0);}
try {
 for(const s of m.segments){const content=readFileSync(join(folder,s.reference),'utf8');const result=manager.execute({action:'write_file',name,file_path:s.reference,file_content:content,expected_revision:revision});revision=result.revision;receipt.writes.push({action:'write_file',file:s.reference,revision});writeFileSync(receiptPath,JSON.stringify(receipt,null,2));}
 if(sha(readFileSync(source))!==m.source_sha256)throw Error('Body changed during support publication');
 const result=manager.execute({action:'patch',name,instructions:match[2].trim(),expected_revision:revision});receipt.finalRevision=result.revision;receipt.applied=true;
 viewed=manager.execute({action:'view',name,limit:1});if(viewed.instructions_total!==match[2].trim())throw Error('Published body mismatch');
 for(const s of m.segments)if(sha(readFileSync(join(root,name,s.reference)))!==s.section_sha256)throw Error('Published reference mismatch');
 receipt.verified=true;receipt.finalSourceSha256=sha(readFileSync(source));receipt.metadataNote='Canonical patch increments version and normalizes frontmatter; instruction content matched exactly.';
}finally{writeFileSync(receiptPath,JSON.stringify(receipt,null,2));}
console.log(JSON.stringify(receipt));
