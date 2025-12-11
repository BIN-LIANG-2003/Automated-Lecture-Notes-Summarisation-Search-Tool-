import sqlite3

# 连接数据库
conn = sqlite3.connect('studyhub.db')
cursor = conn.cursor()

# 删除 users 表中的所有数据
cursor.execute('DELETE FROM users')

# 提交更改
conn.commit()
conn.close()

print("所有用户数据已清空！")