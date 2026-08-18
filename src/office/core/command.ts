export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
}

export class UndoStack {
  private readonly done: Command[] = [];
  private readonly undone: Command[] = [];

  execute(command: Command) {
    command.execute();
    this.done.push(command);
    this.undone.length = 0;
  }

  undo() {
    const command = this.done.pop();
    if (!command) return false;
    command.undo();
    this.undone.push(command);
    return true;
  }

  redo() {
    const command = this.undone.pop();
    if (!command) return false;
    command.execute();
    this.done.push(command);
    return true;
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }

  clear() {
    this.done.length = 0;
    this.undone.length = 0;
  }
}

export class LambdaCommand implements Command {
  constructor(
    readonly label: string,
    private readonly run: () => void,
    private readonly reverse: () => void,
  ) {}

  execute() {
    this.run();
  }

  undo() {
    this.reverse();
  }
}
