FROM python:latest

COPY . .

EXPOSE 8000

CMD ["python3", "-m", "http.server", "8000"]
