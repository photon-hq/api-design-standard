export declare const internalTermHashes: Set<string>;
export declare const blockedIssuePrefixHashes: Set<string>;

export interface ContentFindingsOptions {
  checkIssueKeys?: boolean;
  depth?: number;
}

export declare function candidates(text: string): Set<string>;
export declare function contentFindings(text: string, options?: ContentFindingsOptions): string[];
export declare function checkText(
  label: string,
  text: string,
  options?: ContentFindingsOptions,
): void;
