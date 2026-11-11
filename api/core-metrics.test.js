'use strict';
const assert=require('node:assert/strict');
const {calculate}=require('./core-metrics');
const range={from:'2026-10-01 00:00:00',until:'2026-10-31 00:00:00'};
const base={surveys:[],batches:[],participants:[],pairs:[],days:[],excluded:[99],started_at:'2026-10-01T00:00:00Z'};
const now=Date.parse('2026-10-30T00:00:00Z');
function run(data){return calculate({...base,...data},range,now);}
assert.equal(run({}).total.chat.rate,null);
assert.equal(run({}).rows[2].survey,null);
const surveys=[
 {mode:'love',account_id:1,started_at:'2026-10-01 00:00:00',completed_at:'2026-10-02 00:00:00',is_revision:0},
 {mode:'love',account_id:2,started_at:'2026-10-01 00:00:00',completed_at:'2026-10-08 00:00:00',is_revision:0},
 {mode:'love',account_id:3,started_at:'2026-10-29 00:00:00',completed_at:null,is_revision:0},
 {mode:'love',account_id:4,started_at:'2026-10-01 00:00:00',completed_at:null,is_revision:1},
 {mode:'love',account_id:99,started_at:'2026-10-01 00:00:00',completed_at:null,is_revision:0}];
assert.deepEqual(run({surveys}).rows[0].survey,{numerator:1,denominator:2,rate:50,waiting:1});
const batches=[{mode:'deep',batch_key:'2026-10-05',published_at:'2026-10-08 12:00:00'},{mode:'deep',batch_key:'2026-10-12',published_at:'2026-10-15 12:00:00'}];
const participants=[{mode:'deep',batch_key:'2026-10-05',account_id:1,matched:1},{mode:'deep',batch_key:'2026-10-05',account_id:2,matched:0},{mode:'deep',batch_key:'2026-10-12',account_id:1,matched:0}];
assert.deepEqual(run({batches,participants}).rows[1].retention,{numerator:1,denominator:2,rate:50,waiting:1});
assert.deepEqual(run({batches,participants}).rows[1].coverage,{numerator:1,denominator:3,rate:33.3,waiting:0});
const pairs=[{mode:'deep',id:1,a_id:1,b_id:2,published_at:'2026-10-08 12:00:00',agreed:1,first_a:'2026-10-10 15:00:00',first_b:'2026-10-10 16:05:00'},
 {mode:'deep',id:2,a_id:3,b_id:4,published_at:'2026-10-08 12:00:00',agreed:1,first_a:'2026-10-29 00:00:00',first_b:'2026-10-29 00:00:01'},
 {mode:'deep',id:3,a_id:5,b_id:6,published_at:'2026-10-08 12:00:00',agreed:0},
 {mode:'deep',id:4,a_id:99,b_id:7,published_at:'2026-10-08 12:00:00',agreed:1}];
const days=[{mode:'deep',pair_id:1,a_at:'2026-10-11 00:00:00',b_at:'2026-10-11 01:00:00'},
 {mode:'deep',pair_id:1,a_at:'2026-10-12 00:00:00',b_at:'2026-10-12 01:00:00'},
 {mode:'deep',pair_id:1,a_at:'2026-10-17 15:00:00',b_at:'2026-10-17 16:00:00'}];
let r=run({pairs,days}).rows[1];assert.equal(r.agreement.denominator,3);assert.equal(r.agreement.numerator,2);assert.equal(r.chat.rate,100);
assert.deepEqual(r.continuation,{numerator:1,denominator:1,rate:100,waiting:1});
assert.equal(run({pairs,days:days.slice(1)}).rows[1].continuation.numerator,0);
// The next week can be outside the selected range, but must be a complete observed batch.
assert.equal(calculate({...base,batches,participants},{from:'2026-10-01 00:00:00',until:'2026-10-10 00:00:00'},now).rows[1].retention.rate,50);
console.log('PASS: empty cohorts, survey maturity/edit exclusion, weekly retention, denominator weighting, test exclusion, two-way chat and 7-day boundaries');
