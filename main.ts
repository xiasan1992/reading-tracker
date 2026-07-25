import {
  App,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

interface ReadingTrackerSettings {
  dwellThresholdSec: number;
  summaryLines: number;
  outputFolder: string;
  excludeFolders: string;
  skipFrontmatter: boolean;
}

const DEFAULT_SETTINGS: ReadingTrackerSettings = {
  dwellThresholdSec: 15,
  summaryLines: 5,
  outputFolder: "outputs/阅读记录",
  excludeFolders: "",
  skipFrontmatter: true,
};

interface ActiveRecord {
  file: TFile;
  openTime: number;
  dwellMs: number;
  lastCheck: number;
}

export default class ReadingTrackerPlugin extends Plugin {
  settings: ReadingTrackerSettings = DEFAULT_SETTINGS;
  private active: ActiveRecord | null = null;
  private heartbeatId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ReadingTrackerSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        this.onLeafChange(leaf);
      })
    );

    // Seed tracking for a note already open when the plugin loads.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file && this.shouldTrack(view.file)) {
      const now = Date.now();
      this.active = { file: view.file, openTime: now, dwellMs: 0, lastCheck: now };
    }

    // Heartbeat: accumulate dwell only while the Obsidian window is focused.
    this.heartbeatId = window.setInterval(() => {
      const rec = this.active;
      if (!rec) return;
      const now = Date.now();
      if (document.hasFocus()) {
        rec.dwellMs += now - rec.lastCheck;
      }
      rec.lastCheck = now;
    }, 5000);
  }

  onunload(): void {
    if (this.heartbeatId !== null) {
      window.clearInterval(this.heartbeatId);
      this.heartbeatId = null;
    }
    this.commitActive();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private onLeafChange(leaf: WorkspaceLeaf | null): void {
    this.commitActive();
    if (leaf && leaf.view instanceof MarkdownView && leaf.view.file) {
      const file = leaf.view.file;
      if (this.shouldTrack(file)) {
        const now = Date.now();
        this.active = { file, openTime: now, dwellMs: 0, lastCheck: now };
        return;
      }
    }
    this.active = null;
  }

  private commitActive(): void {
    const rec = this.active;
    this.active = null;
    if (!rec) return;
    const now = Date.now();
    if (document.hasFocus()) {
      rec.dwellMs += now - rec.lastCheck;
    }
    const threshold = this.settings.dwellThresholdSec * 1000;
    if (rec.dwellMs >= threshold) {
      void this.appendRecord(rec).catch((e) => {
        console.error("[reading-tracker] appendRecord failed", e);
      });
    }
  }

  private shouldTrack(file: TFile): boolean {
    const path = file.path;
    const out = this.normalizeFolder(this.settings.outputFolder);
    if (path === out || path.startsWith(out + "/")) return false;
    const excludes = this.settings.excludeFolders
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => this.normalizeFolder(s));
    for (const ex of excludes) {
      if (path === ex || path.startsWith(ex + "/")) return false;
    }
    return true;
  }

  private normalizeFolder(folder: string): string {
    return folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private dailyPath(dateStr: string): string {
    return `${this.normalizeFolder(this.settings.outputFolder)}/${dateStr}.md`;
  }

  private async ensureFolder(folder: string): Promise<void> {
    const parts = this.normalizeFolder(folder)
      .split("/")
      .filter((p) => p.length > 0);
    let cur = "";
    for (const p of parts) {
      cur = cur.length > 0 ? `${cur}/${p}` : p;
      const existing = this.app.vault.getAbstractFileByPath(cur);
      if (!existing) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          // May have been created concurrently; ignore.
        }
      }
    }
  }

  private async appendRecord(rec: ActiveRecord): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(rec.file.path);
    if (!(file instanceof TFile)) return;

    const noteContent = await this.app.vault.read(file);
    const summary = this.extractSummary(noteContent);

    const dateStr = this.formatDate(rec.openTime);
    const timeStr = this.formatTime(rec.openTime);
    const dwellStr = this.formatDwell(rec.dwellMs);
    const filePath = this.dailyPath(dateStr);
    const link = this.app.fileManager.generateMarkdownLink(file, filePath);

    const folder = this.normalizeFolder(this.settings.outputFolder);
    await this.ensureFolder(folder);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    let seq = 1;
    let header: string;
    if (existing instanceof TFile) {
      const old = await this.app.vault.read(existing);
      const count = old.split("\n").filter((l) => l.startsWith("## ")).length;
      seq = count + 1;
      header = old.replace(/\s+$/, "") + "\n\n";
    } else {
      header = `# 阅读记录 ${dateStr}\n\n`;
    }
    const section = `## ${seq}. ${link} · ${timeStr} · ${dwellStr}\n\n${summary}\n`;
    const newContent = header + section;

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, newContent);
    } else {
      await this.app.vault.create(filePath, newContent);
    }
  }

  private extractSummary(content: string): string {
    let text = content;
    if (this.settings.skipFrontmatter && text.startsWith("---")) {
      const end = text.indexOf("\n---", 3);
      if (end !== -1) {
        text = text.slice(end + 4);
        if (text.startsWith("\r")) text = text.slice(1);
        if (text.startsWith("\n")) text = text.slice(1);
      }
    }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const n = Math.max(1, this.settings.summaryLines);
    return lines.slice(0, n).join("\n");
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${mi}`;
  }

  private formatDwell(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}h${String(m).padStart(2, "0")}m`;
    }
    return `${m}m${s}s`;
  }
}

class ReadingTrackerSettingTab extends PluginSettingTab {
  plugin: ReadingTrackerPlugin;

  constructor(app: App, plugin: ReadingTrackerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("停留阈值（秒）")
      .setDesc("停留超过此时长才算已读，写入阅读记录。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.dwellThresholdSec))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 0) {
              this.plugin.settings.dwellThresholdSec = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("摘要行数")
      .setDesc("每篇笔记截取正文前 N 行作为摘要。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.summaryLines))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 1) {
              this.plugin.settings.summaryLines = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("输出文件夹")
      .setDesc("阅读记录存放的 Vault 内文件夹路径。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("排除文件夹")
      .setDesc("每行一个文件夹路径，这些文件夹下的笔记不被追踪。")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.excludeFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName("跳过 frontmatter")
      .setDesc("摘要截取时跳过 YAML frontmatter。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.skipFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.skipFrontmatter = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

