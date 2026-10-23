export type SkillSourceDocument = {
  name: string;
  description: string;
  body: string;
  files?: Array<{ path: string; body: string }>;
  path: string;
};
