export class ProjectRegistry {
  public async load(): Promise<void> {
    throw new Error("Not implemented: Story 1.3");
  }

  public async save(): Promise<void> {
    throw new Error("Not implemented: Story 1.3");
  }

  public async register(_projectPath: string): Promise<{ projectId: string; path: string; status: string }> {
    throw new Error("Not implemented: Story 1.3");
  }

  public async list(): Promise<Array<{ projectId: string; path: string; status: string }>> {
    throw new Error("Not implemented: Story 1.3");
  }

  public async unregister(_projectId: string): Promise<{ projectId: string; removed: boolean }> {
    throw new Error("Not implemented: Story 1.3");
  }
}
