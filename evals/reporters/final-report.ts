import { writeFile } from 'node:fs/promises';

import { assertString, invariant } from '../../src/util/assert.js';

import {
  generateJsonReport,
  generateMarkdownReport,
} from '../lib/reporting.js';
import type {
  BaselineComparison,
  ComparisonMetrics,
  EvalResult,
  RunMetadata,
} from '../lib/types.js';
import type { Reporter, RunFinishEvent } from './types.js';

export interface FinalReportInputs {
  results: EvalResult[];
  metadata: RunMetadata;
  comparisonMetrics?: ComparisonMetrics[] | ComparisonMetrics;
  baselineComparison?: BaselineComparison;
  jsonReportPath: string;
  markdownReportPath: string;
}

export interface FinalReportReporterContext {
  getFinalReportInputs: () => FinalReportInputs | null;
}

export class FinalReportReporter implements Reporter {
  public readonly name = 'final';

  private readonly getFinalReportInputs: () => FinalReportInputs | null;

  public constructor(context: FinalReportReporterContext) {
    invariant(
      context !== null && context !== undefined,
      'final report reporter context is required',
    );
    invariant(
      typeof context.getFinalReportInputs === 'function',
      'final report reporter getFinalReportInputs must be a function',
    );

    this.getFinalReportInputs = context.getFinalReportInputs;
  }

  public async onRunFinish(event: RunFinishEvent): Promise<void> {
    const inputs = this.getFinalReportInputs();
    if (inputs === null) {
      return;
    }

    assertString(
      inputs.jsonReportPath,
      'final report reporter jsonReportPath must be a string',
    );
    invariant(
      inputs.jsonReportPath.length > 0,
      'final report reporter jsonReportPath must not be empty',
    );
    assertString(
      inputs.markdownReportPath,
      'final report reporter markdownReportPath must be a string',
    );
    invariant(
      inputs.markdownReportPath.length > 0,
      'final report reporter markdownReportPath must not be empty',
    );

    const jsonReport = generateJsonReport(
      inputs.results,
      inputs.metadata,
      inputs.comparisonMetrics,
      inputs.baselineComparison,
      event.tokenReport,
    );
    const markdownReport = generateMarkdownReport(
      inputs.results,
      inputs.metadata,
      inputs.comparisonMetrics,
      inputs.baselineComparison,
      event.tokenReport,
    );

    await writeFile(
      inputs.jsonReportPath,
      `${JSON.stringify(jsonReport, null, 2)}\n`,
      'utf8',
    );
    await writeFile(inputs.markdownReportPath, markdownReport, 'utf8');
  }
}
