# HTML Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: Palatino, Georgia, serif;
            background: #fffff8;
            padding: 40px 60px;
            max-width: 1200px;
            margin: 0 auto;
            color: #111;
        }
        .num { font-family: 'Source Sans Pro', sans-serif; font-variant-numeric: tabular-nums; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 32px; }
        .grid-2 { display: grid; grid-template-columns: 2fr 1fr; gap: 40px; }
        .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #999; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 12px; }
        .big-number { font-size: 42px; letter-spacing: -1px; line-height: 1; }
        .big-number-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; font-weight: 400; color: #999; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 8px 4px 0; border-bottom: 1px solid #ccc; }
        td { padding: 5px 8px 5px 0; border-bottom: 1px solid #eee; }
        .bar-container { background: #f0f0f0; height: 12px; width: 100px; }
        .bar { background: #888; height: 100%; }
        .highlight { background: rgba(160,0,0,0.08); padding: 0 3px; }
        .accent { color: #a00; }
    </style>
</head>
<body>
    <!-- KPI row, main content, detail sections -->
</body>
</html>
```
