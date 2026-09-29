$ErrorActionPreference = 'Stop'

$Source = 'C:\Users\Lenovo\.codex\attachments\2edcd572-9631-4692-8974-ed307b8a714f\pasted-text.txt'
$WorkDir = 'C:\Users\Lenovo\Desktop\project\word_build'
$Markdown = Join-Path $WorkDir 'handover.md'
$Output = 'C:\Users\Lenovo\Desktop\project\智能井盖项目交接摘要.docx'
$Pdf = Join-Path $WorkDir '智能井盖项目交接摘要.pdf'
$Pandoc = 'C:\Users\Lenovo\anaconda3\Library\bin\pandoc.exe'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$body = Get-Content -Raw -Encoding UTF8 $Source
$body = $body -replace '^# 智能井盖项目交接摘要\s*', ''
$body = $body -replace '\]\(/C:/', '](file:///C:/'

$front = @'
---
title: "智能井盖项目交接摘要"
subtitle: "ESP32-S3 多传感器监测、声光报警与 Cat.1/GPS 云端方案"
date: "整理日期：2026年8月18日"
lang: zh-CN
---

```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# 目录

- [1. 已完成工作](#1-已完成工作)
- [2. 当前硬件和软件状态](#2-当前硬件和软件状态)
- [3. 已确定的技术方案](#3-已确定的技术方案)
- [4. 关键参数、引脚和通信协议](#4-关键参数引脚和通信协议)
- [5. 尚未解决的问题](#5-尚未解决的问题)
- [6. 下一步建议](#6-下一步建议)

```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

'@
Set-Content -Path $Markdown -Value ($front + $body) -Encoding UTF8

& $Pandoc $Markdown --from markdown+raw_attribute --to docx --output $Output
if ($LASTEXITCODE -ne 0) { throw "Pandoc failed with exit code $LASTEXITCODE" }

$word = New-Object -ComObject Word.Application
$doc = $null
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($Output)
    $sec = $doc.Sections.Item(1)
    $sec.PageSetup.PageWidth = $word.InchesToPoints(8.5)
    $sec.PageSetup.PageHeight = $word.InchesToPoints(11)
    $sec.PageSetup.TopMargin = $word.InchesToPoints(0.85)
    $sec.PageSetup.BottomMargin = $word.InchesToPoints(0.8)
    $sec.PageSetup.LeftMargin = $word.InchesToPoints(0.9)
    $sec.PageSetup.RightMargin = $word.InchesToPoints(0.9)
    $sec.PageSetup.HeaderDistance = $word.InchesToPoints(0.35)
    $sec.PageSetup.FooterDistance = $word.InchesToPoints(0.35)

    function Set-Style([int]$styleId, [double]$size, [int]$color, [bool]$bold, [double]$before, [double]$after, [double]$line) {
        $s = $doc.Styles.Item($styleId)
        $s.Font.Name = 'Calibri'
        $s.Font.NameFarEast = 'Microsoft YaHei'
        $s.Font.Size = $size
        $s.Font.Bold = [int]$bold
        $s.Font.Color = $color
        $s.ParagraphFormat.SpaceBefore = $before
        $s.ParagraphFormat.SpaceAfter = $after
        $s.ParagraphFormat.LineSpacingRule = 5
        $s.ParagraphFormat.LineSpacing = $line
    }

    Set-Style -1 10.5 0 $false 0 6 15.5
    Set-Style -63 28 7616800 $true 85 10 32
    Set-Style -75 13 6908265 $false 0 8 18
    Set-Style -2 16 11826215 $true 18 10 21
    Set-Style -3 13 11826215 $true 14 7 18
    Set-Style -4 11.5 7884063 $true 10 5 16

    $doc.Styles.Item(-63).ParagraphFormat.Alignment = 1
    $doc.Styles.Item(-75).ParagraphFormat.Alignment = 1
    $doc.Styles.Item(-2).ParagraphFormat.KeepWithNext = -1
    $doc.Styles.Item(-3).ParagraphFormat.KeepWithNext = -1
    $doc.Styles.Item(-4).ParagraphFormat.KeepWithNext = -1

    foreach ($p in $doc.Paragraphs) {
        $p.Range.Font.NameFarEast = 'Microsoft YaHei'
        if ($p.Range.Style.NameLocal -match 'Date|日期') {
            $p.Range.ParagraphFormat.Alignment = 1
            $p.Range.Font.Color = 6908265
            $p.Range.Font.Size = 10.5
        }
    }

    foreach ($table in $doc.Tables) {
        $table.AllowAutoFit = $true
        $table.AutoFitBehavior(2)
        $table.Rows.Alignment = 0
        $table.Range.Font.Name = 'Calibri'
        $table.Range.Font.NameFarEast = 'Microsoft YaHei'
        $table.Range.Font.Size = 9.5
        $table.Range.ParagraphFormat.SpaceAfter = 2
        $table.Range.ParagraphFormat.LineSpacingRule = 0
        $table.Borders.Enable = 1
        if ($table.Rows.Count -gt 0) {
            $hdr = $table.Rows.Item(1)
            $hdr.Range.Bold = 1
            $hdr.Range.Font.Color = 16777215
            $hdr.Shading.BackgroundPatternColor = 11826215
            $hdr.HeadingFormat = -1
        }
        foreach ($row in $table.Rows) {
            $row.AllowBreakAcrossPages = 0
        }
        foreach ($cell in $table.Range.Cells) {
            $cell.VerticalAlignment = 1
            $cell.TopPadding = 4
            $cell.BottomPadding = 4
            $cell.LeftPadding = 6
            $cell.RightPadding = 6
        }
    }

    $header = $sec.Headers.Item(1).Range
    $header.Text = '智能井盖项目  |  技术交接文档'
    $header.Font.Name = 'Calibri'
    $header.Font.NameFarEast = 'Microsoft YaHei'
    $header.Font.Size = 8.5
    $header.Font.Color = 8421504
    $header.ParagraphFormat.Alignment = 0

    $footer = $sec.Footers.Item(1).Range
    $footer.Text = '第 '
    $footer.Collapse(0)
    $footer.Fields.Add($footer, 33) | Out-Null
    $footer.InsertAfter(' 页')
    $sec.Footers.Item(1).Range.ParagraphFormat.Alignment = 1
    $sec.Footers.Item(1).Range.Font.NameFarEast = 'Microsoft YaHei'
    $sec.Footers.Item(1).Range.Font.Size = 8.5
    $sec.Footers.Item(1).Range.Font.Color = 8421504

    $doc.Fields.Update() | Out-Null
    $doc.Save()
    $doc.ExportAsFixedFormat($Pdf, 17)
    $doc.Close()
}
finally {
    if ($null -ne $doc) {
        try { $doc.Close(0) } catch {}
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null } catch {}
    }
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

Write-Output $Output
Write-Output $Pdf
