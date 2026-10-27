#!/usr/bin/env python3
"""Real PTY -> streaming decoder -> paste router -> real bridge. No model/clipboard.
Run from the repository root. Measures draft completion, not host painting.
"""
import json, os, pty, select, subprocess, time, tty
SOURCE = r'''
import {StringDecoder} from 'node:string_decoder';
import {PasteInput} from './.pi/lib/tern/paste-input.ts';
import {PiTernBridge} from './.pi/lib/tern/bridge.ts';
let renders=0,sends=0;
const bridge=new PiTernBridge({subscribe:()=>()=>{},prompt:async()=>{sends++},abort:async()=>{},dispose(){}},{write(){},surfaceId:'pty-test',credits:1000,onRender:()=>renders++});
bridge.start();
const decoder=new StringDecoder('utf8');
const input=new PasteInput(()=>{},text=>{const before=renders;bridge.pasteText(text);console.log(JSON.stringify({draft:bridge.expandedDraft,renders:renders-before,sends}));});
process.stdin.setRawMode(true);process.stdin.on('data',b=>input.process(decoder.write(b)));console.log('READY');
'''
for text in ['hello world', 'x'*10000, 'first\r\nsecond\rthird\t', 'e\u0301漢🙂\x1b_tsp;e;{"ev":"gone"}\x1b\\']:
    master, slave = pty.openpty(); tty.setraw(slave)
    child = subprocess.Popen(['node', '--experimental-strip-types', '--input-type=module', '-e', SOURCE], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    def read_line():
        out = b''; deadline = time.monotonic()+10
        while time.monotonic() < deadline:
            if select.select([master], [], [], .02)[0]:
                out += os.read(master, 65536)
                if b'\n' in out: return out.strip()
        raise TimeoutError('PTY response')
    try:
        assert read_line() == b'READY'
        wire = ('\x1b[200~'+text+'\x1b[201~').encode(); start=time.monotonic()
        for at in range(0,len(wire),17):
            part=wire[at:at+17]
            while part: part=part[os.write(master,part):]
        result=json.loads(read_line()); elapsed=(time.monotonic()-start)*1000
        assert result['draft']==text and result['renders']==1 and result['sends']==0, result
        print(json.dumps({'utf8Bytes':len(text.encode()),'ptyDraftMs':round(elapsed,3),'exact':True,'renders':1,'sends':0}))
    finally:
        child.terminate(); child.wait(timeout=10); os.close(master)
