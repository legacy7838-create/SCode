"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

type MarkdownListNodeProp = {
  node?: unknown;
};

export type MarkdownUnorderedListProps = ComponentProps<"ul"> & MarkdownListNodeProp;

export function MarkdownUnorderedList({
  className,
  node: _node,
  ...props
}: MarkdownUnorderedListProps) {
  return (
    <ul
      className={cn(
        "my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-foreground-subtlest",
        "[&_ul]:my-1.5 [&_ol]:my-1.5",
        className,
      )}
      data-markdown-list="unordered"
      data-streamdown="unordered-list"
      {...props}
    />
  );
}

export type MarkdownOrderedListProps = ComponentProps<"ol"> & MarkdownListNodeProp;

export function MarkdownOrderedList({
  className,
  node: _node,
  ...props
}: MarkdownOrderedListProps) {
  return (
    <ol
      className={cn(
        // When the ordered list number reaches two/three digits, list-outside will expand the marker to the outside of the parent container;
        // There is overflow-hidden on the outer layer of the message bubble, and the left side of the number will be truncated if the pl is not indented enough.
        "my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-foreground-subtlest",
        "[&_ul]:my-1.5 [&_ol]:my-1.5",
        className,
      )}
      data-markdown-list="ordered"
      data-streamdown="ordered-list"
      {...props}
    />
  );
}

export type MarkdownListItemProps = ComponentProps<"li"> & MarkdownListNodeProp;

export function MarkdownListItem({ className, node: _node, ...props }: MarkdownListItemProps) {
  return (
    <li
      className={cn("pl-1 [&>p]:my-0 [&>p]:inline", className)}
      data-streamdown="list-item"
      {...props}
    />
  );
}
