export interface SkillResult {
  name: string;
  source: 'packaged-file';
  content: string;
}

export interface SkillDependencies {
  readFile: (path: URL, encoding: 'utf8') => Promise<string>;
  skillFileUrl: URL;
}

export declare function loadPackagedSkillContent(
  dependencies?: Partial<SkillDependencies>,
): Promise<string>;

export declare function buildSkillResult(
  dependencies?: Partial<SkillDependencies>,
): Promise<SkillResult>;

export declare function runSkillCommand(options: {
  json: boolean;
}): Promise<void>;
