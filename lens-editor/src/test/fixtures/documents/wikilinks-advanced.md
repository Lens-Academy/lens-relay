# Advanced Wikilinks Test Document

## Basic Links
Simple: [[Note]]
Multiple: [[PageOne]] and [[PageTwo]]

## With Anchors
Section link: [[Note#Introduction]]
Deep anchor: [[Guide#Chapter 1#Section 2]]

## With Aliases
Aliased: [[Note|My Favorite Note]]
Long alias: [[Very Long Page Name|Short]]

## Combined
Full syntax: [[Note#Section|Display Text]]

## Edge Cases
Empty: [[]]
Unclosed: [[Broken
Just brackets: [ [Not a link] ]

## In Code (should be ignored)
Inline: `[[CodeNote]]`

Code block:
```
[[BlockNote]]
```

## Duplicates
Same link twice: [[Duplicate]] and [[Duplicate]]

## Special Characters
With spaces: [[My Note]]
With numbers: [[Note 123]]
