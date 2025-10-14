import type { Principal } from 'npm:@dfinity/principal';
import type { ActorMethod } from 'npm:@dfinity/agent';
import type { IDL } from 'npm:@dfinity/candid';

export interface _SERVICE {
  'checkChallenge' : ActorMethod<
    [Principal],
    [] | [[bigint, Uint8Array | number[]]]
  >,
  'submitChallenge' : ActorMethod<[Uint8Array | number[]], undefined>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];

