import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';

test('assigns first two connected players runner and hunter',()=>{const g=new Game();const a=g.connect('player-0001','s1','A',1000);const b=g.connect('player-0002','s2','B',1000);assert.equal(a.role,'runner');assert.equal(b.role,'hunter');});
test('spectator positions are not accepted',()=>{const g=new Game();g.connect('player-0001','s1','A',1000);g.connect('player-0002','s2','B',1000);const c=g.connect('player-0003','s3','C',1000);assert.equal(c.role,'spectator');assert.equal(g.updatePosition(c.id,{lat:0,lng:0,accuracy:1},1200),false);});
test('rematch swaps roles after completed round',()=>{const g=new Game();const a=g.connect('player-0001','s1','A',1000);const b=g.connect('player-0002','s2','B',1000);g.phase='ended';assert.equal(g.rematch(a.id,2000),true);assert.equal(a.role,'hunter');assert.equal(b.role,'runner');assert.equal(g.phase,'waiting');});
