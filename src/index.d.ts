export type ComputerResult = Record<string, unknown>;

export interface ComputerOptions {
  session?: string;
  desktopBin?: string;
  browserBin?: string;
  pythonBin?: string;
  programDir?: string;
  allowHeaded?: boolean;
  allowCoordinates?: boolean;
  allowedApps?: string[] | null;
  allowedDomains?: string[] | null;
}

export class ActionPolicy {
  constructor(options?: ComputerOptions);
  allowHeaded: boolean;
  allowCoordinates: boolean;
  allowedApps: string[] | null;
  allowedDomains: string[] | null;
  checkApp(app?: string): void;
  checkUrl(url?: string): void;
  requireCoordinates(): void;
  requireHeaded(method: string, headed?: boolean): void;
}

export class Computer {
  constructor(options?: ComputerOptions);
  readonly policy: ActionPolicy;
  doctor(): Promise<ComputerResult>;
  observe(input?: ComputerResult): Promise<ComputerResult>;
  act(input?: ComputerResult): Promise<ComputerResult>;
  verify(expect?: ComputerResult): Promise<ComputerResult>;
  run(steps: ComputerResult[], options?: ComputerResult): Promise<ComputerResult[]>;
  saveProgram(definition: ComputerResult): ComputerResult;
  listPrograms(): ComputerResult[];
  runProgram(name: string, params?: ComputerResult): Promise<ComputerResult>;
  close(): Promise<void>;
}

export function createComputer(options?: ComputerOptions): Promise<Computer>;
