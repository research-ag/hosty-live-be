export const idlFactory = ({ IDL }) => {
  return IDL.Service({
    'checkChallenge' : IDL.Func(
        [IDL.Principal],
        [IDL.Opt(IDL.Tuple(IDL.Nat64, IDL.Vec(IDL.Nat8)))],
        ['query'],
      ),
    'submitChallenge' : IDL.Func([IDL.Vec(IDL.Nat8)], [], []),
  });
};
export const init = ({ IDL }) => { return []; };

