#!/bin/bash

echo "正在启动 Windsurf-Tool..."

# 检查 node_modules 是否存在
if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
fi

# 启动应用
echo "启动应用..."
npm start
