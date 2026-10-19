import * as vscode from "vscode";
import { Catalog, findDefinitionAt } from "./catalog";
import { formatProto } from "./formatProto";

const SELECTOR: vscode.DocumentSelector = [
  { language: "protobuf", scheme: "file" },
  { language: "protobuf", scheme: "untitled" },
  { pattern: "**/*.proto", scheme: "file" },
];

const KEYWORDS = [
  "syntax", "package", "import", "option", "message", "enum", "service", "rpc",
  "returns", "stream", "repeated", "optional", "required", "oneof", "map",
  "reserved", "to", "max", "true", "false", "public", "weak",
];

const SCALARS = [
  "double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
  "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes",
];

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  getCatalog: () => Catalog | undefined,
): void {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition(document, position) {
        const catalog = getCatalog();
        if (!catalog) return;
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][\w.]*/);
        if (!range) return;
        const word = document.getText(range);
        const loc = findDefinitionAt(catalog, document.uri.fsPath, position.line + 1, word);
        if (!loc) return;
        return new vscode.Location(
          vscode.Uri.file(loc.file),
          new vscode.Position(Math.max(0, loc.line - 1), 0),
        );
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems(document, position) {
          const catalog = getCatalog();
          const items: vscode.CompletionItem[] = [];
          for (const word of KEYWORDS) {
            const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
            item.sortText = `0_${word}`;
            items.push(item);
          }
          for (const word of SCALARS) {
            const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.TypeParameter);
            item.detail = "scalar";
            item.sortText = `1_${word}`;
            items.push(item);
          }
          if (catalog) {
            for (const pkg of catalog.packages) {
              for (const message of pkg.messages) {
                const item = new vscode.CompletionItem(message.name, vscode.CompletionItemKind.Struct);
                item.detail = `message ${message.fullName}`;
                item.documentation = message.comment || message.relPath;
                item.insertText = message.name;
                item.sortText = `2_${message.name}`;
                items.push(item);
                if (message.fullName !== message.name) {
                  const qualified = new vscode.CompletionItem(message.fullName, vscode.CompletionItemKind.Struct);
                  qualified.detail = "message";
                  qualified.sortText = `3_${message.fullName}`;
                  items.push(qualified);
                }
              }
              for (const itemEnum of pkg.enums) {
                const item = new vscode.CompletionItem(itemEnum.name, vscode.CompletionItemKind.Enum);
                item.detail = `enum ${itemEnum.fullName}`;
                item.documentation = itemEnum.comment || itemEnum.relPath;
                item.sortText = `2_${itemEnum.name}`;
                items.push(item);
              }
              for (const service of pkg.services) {
                const item = new vscode.CompletionItem(service.name, vscode.CompletionItemKind.Interface);
                item.detail = `service ${pkg.name}.${service.name}`;
                item.sortText = `2_${service.name}`;
                items.push(item);
              }
            }
          }
          const prefix = document.lineAt(position).text.slice(0, position.character);
          if (/\brpc\s+\w*$/.test(prefix)) {
            // keep items as-is for rpc names / types
          }
          return items;
        },
      },
      ".",
    ),
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      provideDocumentFormattingEdits(document) {
        const formatted = formatProto(document.getText());
        if (formatted === document.getText()) return [];
        const full = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        );
        return [vscode.TextEdit.replace(full, formatted)];
      },
    }),
    vscode.commands.registerCommand("protoview.formatDocument", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".proto")) {
        void vscode.window.showWarningMessage("请先打开一个 .proto 文件");
        return;
      }
      await vscode.commands.executeCommand("editor.action.formatDocument");
    }),
  );
}
