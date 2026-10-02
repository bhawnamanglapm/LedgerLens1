import json
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
pages=json.load(open('multi_pages.json'))
c=canvas.Canvas('test-statements/02_multi_month_multi_account.pdf', pagesize=landscape(A4)); W,H=landscape(A4)
cols=[36,96,156,600,670,740]
for p in pages:
    y=H-40
    for ln in p['text'].split('\n'):
        if not ln.strip(): y-=4; continue
        if ln.startswith('|---'): continue
        if ln.startswith('|'):
            cells=[x.strip() for x in ln.strip('|').split('|')]
            if cells[0]=='Date': c.setFont('Helvetica-Bold',8)
            else: c.setFont('Helvetica',7.4)
            c.drawString(cols[0],y,cells[0]); c.drawString(cols[1],y,cells[1]); c.drawString(cols[2],y,cells[2][:88])
            if cells[0]=='Date':
                c.drawString(cols[3],y,'Debit'); c.drawString(cols[4],y,'Credit'); c.drawString(cols[5],y,'Balance')
            else:
                c.drawRightString(cols[3]+55,y,cells[3]); c.drawRightString(cols[4]+55,y,cells[4]); c.drawRightString(cols[5]+60,y,cells[5])
            y-=13
        elif ln.startswith('Page '):
            c.setFont('Helvetica',8); c.drawString(36,24,ln); c.drawRightString(W-36,24,'Synthetic statement for testing — not a real account.')
        else:
            bold = ' | ' in ln
            c.setFont('Helvetica-Bold' if bold else 'Helvetica', 12 if bold else 9); c.drawString(36,y,ln); y-= 18 if bold else 12
    c.showPage()
c.save(); print(len(pages))
