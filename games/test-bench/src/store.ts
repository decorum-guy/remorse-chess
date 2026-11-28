import Database from 'better-sqlite3';
import { chmodSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BenchState } from './types';

export interface MatchRow { match_id:string;start_command_id:string;room_id:string;request_hash:string;state:string }
export interface ReceiptRow { request_hash:string;response:string }
export class BenchStore {
  private readonly db:Database.Database;
  constructor(path:string){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new Database(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.pragma('busy_timeout = 5000');this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS test_bench_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO test_bench_schema VALUES(1,1);
      CREATE TABLE IF NOT EXISTS test_bench_matches(match_id TEXT PRIMARY KEY,start_command_id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS test_bench_receipts(match_id TEXT NOT NULL REFERENCES test_bench_matches(match_id),participant_id TEXT NOT NULL,action_id TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(match_id,participant_id,action_id));`);
    const version=this.db.prepare('SELECT version FROM test_bench_schema WHERE singleton=1').get() as {version:number};if(version.version!==1){this.db.close();throw new Error('Unsupported Test Bench database schema');}
  }
  read(matchId:string):MatchRow|undefined{return this.db.prepare('SELECT * FROM test_bench_matches WHERE match_id=?').get(matchId) as MatchRow|undefined;}
  byStartOrRoom(startId:string,roomId:string):MatchRow|undefined{return this.db.prepare('SELECT * FROM test_bench_matches WHERE start_command_id=? OR room_id=?').get(startId,roomId) as MatchRow|undefined;}
  all():MatchRow[]{return this.db.prepare('SELECT * FROM test_bench_matches').all() as MatchRow[];}
  create(state:BenchState,startId:string,hash:string):void {this.db.prepare('INSERT INTO test_bench_matches VALUES(?,?,?,?,?)').run(state.matchId,startId,state.roomId,hash,JSON.stringify(state));}
  save(state:BenchState):void{this.db.prepare('UPDATE test_bench_matches SET state=? WHERE match_id=?').run(JSON.stringify(state),state.matchId);}
  receipt(matchId:string,participantId:string,actionId:string):ReceiptRow|undefined{return this.db.prepare('SELECT request_hash,response FROM test_bench_receipts WHERE match_id=? AND participant_id=? AND action_id=?').get(matchId,participantId,actionId) as ReceiptRow|undefined;}
  saveWithReceipt(state:BenchState,participantId:string,actionId:string,hash:string,response:unknown):void{this.db.transaction(()=>{this.save(state);this.db.prepare('INSERT INTO test_bench_receipts VALUES(?,?,?,?,?)').run(state.matchId,participantId,actionId,hash,JSON.stringify(response));}).immediate();}
  close():void{this.db.close();}
}
