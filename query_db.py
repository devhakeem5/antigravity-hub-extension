import sqlite3
import json
import sys

db_path = r"C:\Users\HaKeeM\AppData\Roaming\Antigravity\User\globalStorage\state.vscdb"
try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM ItemTable")
    rows = cursor.fetchall()
    
    found = False
    for key, value in rows:
        if key == 'antigravityUnifiedStateSync.oauthToken':
            print(f"Key: {key}")
            print(f"Value: {value}")
            
    if not found:
        print("No related keys found in state.vscdb")
        
except Exception as e:
    print(f"Error: {e}")
