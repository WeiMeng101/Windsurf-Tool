#!/usr/bin/env python3
"""Temporary script to remove extracted IPC handler blocks from main.js"""

with open('main.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Block 1: Remove from '// 批量获取Token的取消标志' to before "app.on('window-all-closed'"
marker1_start = '// \u6279\u91cf\u83b7\u53d6Token\u7684\u53d6\u6d88\u6807\u5fd7'
marker1_end = "app.on('window-all-closed'"
idx1_start = content.index(marker1_start)
idx1_end = content.index(marker1_end)
# Find the start of the line containing marker1_end
line_start = content.rfind('\n', 0, idx1_end) + 1
content = content[:idx1_start] + content[line_start:]
print(f'Block 1 removed: {idx1_end - idx1_start} chars')

# Block 2: Remove from '// ==================== IPC' to before 'module.exports'
marker2_start = '// ==================== IPC'
marker2_end = 'module.exports'
idx2_start = content.index(marker2_start)
idx2_end = content.index(marker2_end)
# Also remove the preceding blank line
start_pos = max(0, content.rfind('\n', 0, idx2_start))
content = content[:start_pos] + '\n\n' + content[idx2_end:]
print(f'Block 2 removed: {idx2_end - idx2_start} chars')

with open('main.js', 'w', encoding='utf-8') as f:
    f.write(content)

line_count = content.count('\n') + 1
print(f'New main.js: {line_count} lines')
