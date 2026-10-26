#!/usr/bin/env python3
"""Import Google Takeout MyActivity.json (AI Mode / Search) into Obsidian Markdown files."""

import argparse
import html
import json
import re
import shutil
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path


def clean_ai_mode_artifacts(raw_html: str) -> str:
    """Remove Google AI Mode internal markup artifacts from HTML."""
    # Remove <ctrl97>tool_code...<ctrl98> blocks
    text = re.sub(
        r"<span>\s*&lt;ctrl97&gt;\s*</span>.*?<span>\s*&lt;ctrl98&gt;\s*</span>",
        "",
        raw_html,
        flags=re.DOTALL,
    )
    # Remove <<!contextual(...)>> and <<!floatImage(...)>> tags (escaped)
    text = re.sub(r"&lt;&lt;!(?:contextual|floatImage)\(.*?\)/&gt;&gt;", "", text, flags=re.DOTALL)
    # Remove <inline entity(...)> wrapper tags while keeping inner text
    text = re.sub(r"&lt;inline\s+entity\(.*?\)&gt;", "", text, flags=re.DOTALL)
    text = re.sub(r"<span>\s*&lt;/inline&gt;\s*</span>|&lt;/inline&gt;", "", text)
    # Convert escaped <br> inside spans (often found in table cells) to <br>
    text = re.sub(r"<span>\s*&lt;br\s*/?&gt;\s*</span>", "<br>", text, flags=re.IGNORECASE)
    # Unwrap escaped emoji brackets in headings like &lt;🗓&gt; -> 🗓
    text = re.sub(r"&lt;([^a-zA-Z0-9_<>/\s]{1,4})&gt;", r"\1", text)
    # Convert {Link: Text URL} pattern to standard anchor tags
    text = re.sub(
        r"\{Link:\s*([^}\n]+?)\s+(https?://[^\s}]+)\}",
        r'<a href="\2">\1</a>',
        text,
    )
    return text


class HTMLToObsidianMarkdown(HTMLParser):
    """Convert Google Takeout safeHtmlItem HTML into Obsidian-flavored Markdown."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.output: list[str] = []
        self.list_stack: list[dict] = []  # [{'type': 'ul'|'ol', 'count': int}]
        self.in_pre = False
        self.in_code = False
        self.code_buffer: list[str] = []
        self.in_blockquote = False
        self.link_stack: list[tuple[str, list[str]]] = []  # [(href, [text_parts])]
        self.in_table = False
        self.table_rows: list[list[str]] = []
        self.current_row: list[str] = []
        self.in_cell = False
        self.cell_buffer: list[str] = []

    def _emit(self, text: str) -> None:
        if self.link_stack:
            self.link_stack[-1][1].append(text)
        elif self.in_cell:
            self.cell_buffer.append(text)
        elif self.in_code:
            self.code_buffer.append(text)
        else:
            self.output.append(text)

    def _quote_prefix(self) -> str:
        return "> " if self.in_blockquote else ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = dict(attrs)

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag[1])
            self._emit(f"\n\n{self._quote_prefix()}{'#' * level} ")
        elif tag == "p":
            if self.list_stack:
                self._emit("\n" + "  " * len(self.list_stack))
            else:
                self._emit(f"\n\n{self._quote_prefix()}")
        elif tag == "br":
            if self.in_cell:
                self._emit("<br>")
            else:
                self._emit(f"\n{self._quote_prefix()}")
        elif tag == "hr":
            self._emit("\n\n---\n\n")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "pre":
            self.in_pre = True
        elif tag == "code":
            self.in_code = True
            self.code_buffer = []
        elif tag == "blockquote":
            self.in_blockquote = True
            self._emit("\n")
        elif tag == "ul":
            self.list_stack.append({"type": "ul", "count": 0})
            if len(self.list_stack) == 1 and not self.in_cell:
                self._emit("\n")
        elif tag == "ol":
            self.list_stack.append({"type": "ol", "count": 0})
            if len(self.list_stack) == 1 and not self.in_cell:
                self._emit("\n")
        elif tag == "li":
            if self.in_cell:
                self._emit("• ")
            elif self.list_stack:
                indent = "  " * (len(self.list_stack) - 1)
                top = self.list_stack[-1]
                if top["type"] == "ol":
                    top["count"] += 1
                    bullet = f"{top['count']}. "
                else:
                    bullet = "- "
                self._emit(f"\n{self._quote_prefix()}{indent}{bullet}")
        elif tag == "a":
            href = html.unescape(attr_dict.get("href") or "")
            self.link_stack.append((href, []))
        elif tag == "table":
            self.in_table = True
            self.table_rows = []
        elif tag == "tr":
            self.current_row = []
        elif tag in ("th", "td"):
            self.in_cell = True
            self.cell_buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._emit("\n")
        elif tag == "p":
            if not self.list_stack:
                self._emit("\n")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code":
            self.in_code = False
            code_text = "".join(self.code_buffer)
            if self.in_pre:
                code_text = code_text.strip("\n")
                self._emit(f"\n\n```\n{code_text}\n```\n\n")
            else:
                if "`" in code_text:
                    self._emit(f"`` {code_text} ``")
                else:
                    self._emit(f"`{code_text}`")
            self.code_buffer = []
        elif tag == "pre":
            self.in_pre = False
        elif tag == "blockquote":
            self.in_blockquote = False
            self._emit("\n")
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            if not self.list_stack and not self.in_cell:
                self._emit("\n")
        elif tag == "li":
            if self.in_cell:
                self._emit(" ")
        elif tag == "a":
            if self.link_stack:
                href, text_parts = self.link_stack.pop()
                text = "".join(text_parts).strip()
                if href and href != "url":
                    self._emit(f"[{text or href}]({href})")
                else:
                    self._emit(text)
        elif tag in ("th", "td"):
            self.in_cell = False
            cell_text = "".join(self.cell_buffer).strip()
            cell_text = re.sub(r"\s*\n\s*", " ", cell_text)
            cell_text = cell_text.replace("|", "\\|")
            self.current_row.append(cell_text)
            self.cell_buffer = []
        elif tag == "tr":
            if self.current_row:
                self.table_rows.append(self.current_row)
            self.current_row = []
        elif tag == "table":
            self.in_table = False
            if self.table_rows:
                self._emit("\n\n" + self._format_table(self.table_rows) + "\n\n")
            self.table_rows = []

    def handle_data(self, data: str) -> None:
        if not self.in_pre and not self.in_code:
            # Collapse pure-newline spacing between block tags while keeping inline spaces
            if data.strip() == "" and "\n" in data:
                return
            data = re.sub(r"[ \t]*\n[ \t]*", " ", data)
        self._emit(data)

    def handle_entityref(self, name: str) -> None:
        self._emit(html.unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        self._emit(html.unescape(f"&#{name};"))

    @staticmethod
    def _format_table(rows: list[list[str]]) -> str:
        col_count = max(len(r) for r in rows)
        normalized = [r + [""] * (col_count - len(r)) for r in rows]
        header = normalized[0]
        lines = [
            "| " + " | ".join(header) + " |",
            "| " + " | ".join(["---"] * col_count) + " |",
        ]
        for row in normalized[1:]:
            lines.append("| " + " | ".join(row) + " |")
        return "\n".join(lines)

    def get_markdown(self) -> str:
        md = "".join(self.output)
        # Format "Your prompt:" and "Search's response:" into clean callouts/sections
        md = re.sub(
            r"\*\*Your prompt:\*\*\s*\n?",
            "### Prompt\n\n",
            md,
        )
        md = re.sub(
            r"\*\*Search's response:\*\*\s*\n?",
            "### Response\n\n",
            md,
        )
        # Clean up empty bold/italic markers or excessive blank lines
        md = re.sub(r"\n[ \t]+\n", "\n\n", md)
        md = re.sub(r"\n{3,}", "\n\n", md)
        return md.strip()


def html_to_markdown(raw_html: str) -> str:
    cleaned = clean_ai_mode_artifacts(raw_html)
    parser = HTMLToObsidianMarkdown()
    parser.feed(cleaned)
    parser.close()
    return parser.get_markdown()


def sanitize_filename(name: str, max_length: int = 80) -> str:
    """Create a filesystem- and Obsidian-safe filename."""
    # Remove "Searched for " or "Prompted " prefix if present
    name = re.sub(r"^(?:Searched for|Prompted)\s+", "", name, flags=re.IGNORECASE).strip()
    # Replace characters invalid in Obsidian / macOS / Windows filenames
    name = re.sub(r'[\\/:*?"<>|#^\[\]\r\n\t]+', " ", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > max_length:
        name = name[:max_length].rsplit(" ", 1)[0].strip(" .")
    return name or "Untitled"


def parse_iso_time(time_str: str) -> tuple[str, str]:
    """Return (YYYY-MM-DD, ISO-string) from Takeout timestamp."""
    if not time_str:
        return "unknown-date", ""
    try:
        dt = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d"), dt.isoformat()
    except ValueError:
        return time_str[:10], time_str


def yaml_escape(val: str) -> str:
    escaped = val.replace("\\", "\\\\").replace('"', '\\"').replace("\r", " ").replace("\n", " ")
    return f'"{escaped}"'


def convert_entry_to_markdown(entry: dict, input_dir: Path, output_dir: Path) -> tuple[str, str] | None:
    """Convert a single Takeout JSON entry into (base_filename, markdown_content)."""
    title = entry.get("title", "").strip()
    html_items = entry.get("safeHtmlItem", [])
    image_file = entry.get("imageFile")

    # Skip generic empty activity entries like "Used AI Mode" with no content
    if not html_items and not image_file and title in ("Used AI Mode", ""):
        return None

    date_prefix, iso_time = parse_iso_time(entry.get("time", ""))
    clean_title = re.sub(r"^(?:Searched for|Prompted)\s+", "", title, flags=re.IGNORECASE).strip() or title or "AI Mode Activity"
    clean_title = re.sub(r"\s+", " ", clean_title)

    # Build YAML frontmatter
    frontmatter = ["---"]
    frontmatter.append(f"title: {yaml_escape(clean_title)}")
    if iso_time:
        frontmatter.append(f"date: {iso_time}")
    if entry.get("titleUrl"):
        frontmatter.append(f"source: {yaml_escape(entry['titleUrl'])}")
    if entry.get("header"):
        frontmatter.append(f"header: {yaml_escape(entry['header'])}")
    products = entry.get("products", [])
    tags = ["google-takeout"] + [re.sub(r"[^a-z0-9-]+", "-", p.lower()).strip("-") for p in products]
    frontmatter.append("tags:")
    for tag in dict.fromkeys(tags):
        frontmatter.append(f"  - {tag}")
    frontmatter.append("---")

    body_parts = [f"# {clean_title}"]

    # Handle attached image file (e.g., Google Lens searches)
    if image_file:
        src_img = input_dir / image_file
        if src_img.exists():
            attachments_dir = output_dir / "attachments"
            attachments_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_img, attachments_dir / src_img.name)
            body_parts.append(f"![[attachments/{src_img.name}]]")
        else:
            body_parts.append(f"![[{image_file}]]")

    # Convert HTML conversation items
    for item in html_items:
        raw_html = item.get("html", "")
        if raw_html:
            md_section = html_to_markdown(raw_html)
            if md_section:
                body_parts.append(md_section)

    safe_name = sanitize_filename(clean_title)
    base_filename = f"{date_prefix} {safe_name}"
    full_content = "\n".join(frontmatter) + "\n\n" + "\n\n".join(body_parts) + "\n"
    return base_filename, full_content


def import_takeout_json(input_json: Path, output_dir: Path) -> int:
    """Read Takeout JSON file and write Obsidian Markdown files to output_dir."""
    if not input_json.exists():
        raise FileNotFoundError(f"Input JSON file not found: {input_json}")

    with input_json.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError("Expected Google Takeout JSON root to be a list of activity objects.")

    output_dir.mkdir(parents=True, exist_ok=True)
    input_dir = input_json.parent

    used_filenames: dict[str, int] = {}
    written_count = 0

    for entry in data:
        if not isinstance(entry, dict):
            continue
        result = convert_entry_to_markdown(entry, input_dir, output_dir)
        if result is None:
            continue

        base_filename, content = result
        count = used_filenames.get(base_filename, 0)
        used_filenames[base_filename] = count + 1
        final_filename = f"{base_filename}.md" if count == 0 else f"{base_filename} ({count + 1}).md"

        output_path = output_dir / final_filename
        output_path.write_text(content, encoding="utf-8")
        written_count += 1

    return written_count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import Google Takeout MyActivity.json into Obsidian Markdown (.md) files."
    )
    parser.add_argument("input_json", type=Path, help="Path to the input Google Takeout .json file")
    parser.add_argument("output_dir", type=Path, help="Path to the output directory for Obsidian .md files")
    args = parser.parse_args()

    try:
        count = import_takeout_json(args.input_json, args.output_dir)
        print(f"Successfully imported {count} notes into '{args.output_dir}'.")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
