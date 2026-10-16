export type PonderHostedSandboxState = {
  enabled:boolean; available:boolean; reason:string|null; revision:number;
  account:{id:string;apiBaseUrl:string;teamId:string|null}|null;
};
export type PonderHostedAssignment = {
  id:string;coordinatorId:string;title:string;assignment:string;
  state:"preparing"|"submitting"|"running"|"needs_attention"|"completed"|"failed"|"cancelled"|"unknown";
  remoteConversationId:string|null;remoteTurnId:string|null;lastSequence:number;
  resultText:string|null;
  wait:{id:string;kind:string;title:string;options:unknown[]}|null;
  error:string|null;createdAt:string;updatedAt:string;canCancel:boolean;
  account:{id:string;apiBaseUrl:string;teamId:string|null};
};
export type PonderHostedAssignmentDetail = {
  assignment:PonderHostedAssignment;
  events:{id:string;sequence:number;type:string;text:string|null}[];
  outputs:{id:string;name:string;mediaType:string|null;byteCount:number|null;previewURL:string|null;downloadURL:string|null}[];
};
