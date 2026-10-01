/** Read identity at each boundary rather than retaining a startup account. */
export function createCurrentWorkspaceIdentity(input:{account():Promise<{state:string;profile?:{id:string|null}|null}>;defaultTeam():Promise<string|null|undefined>}) {
  return {
    async actorId(){const account=await input.account();if(account.state!=="signed_in"||!account.profile?.id)throw new Error("Sign in before accessing this workspace.");return account.profile.id;},
    async teamId(){const id=(await input.defaultTeam())?.trim();if(!id)throw new Error("Select a workspace before accessing its reviews, Experiments or training.");return id;},
  };
}
